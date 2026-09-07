const WORKSPACE_INGRESS_TYPES = new Set([
  'task_assigned',
  'group_message_ingress',
  'requirements_update',
  'result_submitted',
  'revision_requested',
  'result_accepted',
  'submission_update',
]);

const LOCAL_ONLY_WORKSPACE_METADATA_KEYS = new Set([
  'path', 'source_path', 'sourcePath',
  'preview_url', 'previewUrl', 'download_url', 'downloadUrl', 'file_url', 'fileUrl',
  'render_url', 'renderUrl', 'office_pdf_url', 'officePdfUrl',
  'workspace_root', 'workspaceRoot',
]);

function delegationWorkspaceEpoch(delegation = {}) {
  return String(delegation.metadata?.workspaceEpoch || delegation.workspace?.metadata?.workspaceEpoch || '').trim();
}

function delegationWorkspacePreviousSessionId(delegation = {}) {
  return String(delegation.metadata?.previousWorkspaceSessionId || delegation.workspace?.metadata?.previousWorkspaceSessionId || '').trim();
}

function messageDelegationId(message = {}) {
  const metadata = message.metadata || {};
  return String(metadata.delegationId || metadata.delegation_id || metadata.agentDelegationId || '').trim();
}

function workspaceMessageBelongsToDelegation(message = {}, delegationId = '', workspaceEpoch = '', { allowLegacy = false } = {}) {
  const cleanDelegationId = String(delegationId || '').trim();
  if (!cleanDelegationId || !message || !['user', 'assistant', 'system'].includes(String(message.role || ''))) return false;
  const metadata = message.metadata || {};
  const exactMetadataDelegation = messageDelegationId(message) === cleanDelegationId;
  const topLevelDelegation = String(message.delegationId || message.delegation_id || '').trim();
  const systemIngress = message.role === 'system'
    && topLevelDelegation === cleanDelegationId
    && WORKSPACE_INGRESS_TYPES.has(String(metadata.type || ''))
    && Boolean(String(message.sourceEventId || metadata.sourceEventId || '').trim());
  if (!systemIngress && (!exactMetadataDelegation || metadata.privateTaskWorkspace !== true)) return false;
  if (systemIngress) return true;
  const messageEpoch = String(metadata.workspaceEpoch || '').trim();
  if (!workspaceEpoch) return allowLegacy && !messageEpoch;
  return messageEpoch === workspaceEpoch || (allowLegacy && !messageEpoch);
}

function workspaceSessionIsValid(store, session, { userId = '', delegationId = '' } = {}) {
  if (!session || session.userId !== userId || session.departmentId !== 'agent_delegation') return false;
  const reused = store.db.prepare(`SELECT 1 FROM agent_delegation_workspaces
    WHERE session_id = ? AND NOT (delegation_id = ? AND user_id = ?) LIMIT 1`)
    .get(session.id, delegationId, userId);
  return !reused;
}

function ensureDelegationWorkspaceSession({ auth, store, delegation = {}, user = {}, workspaceRoot = '', remoteWorkspace = null, newId } = {}) {
  if (!delegation.id || !user.id || typeof newId !== 'function') throw new Error('Invalid delegation workspace session request.');
  const workspace = auth.delegationWorkspace(delegation.id, user.id);
  const localEpoch = String(workspace?.metadata?.workspaceEpoch || delegation.workspace?.metadata?.workspaceEpoch || delegation.metadata?.workspaceEpoch || '').trim();
  const remoteEpoch = String(remoteWorkspace?.metadata?.workspaceEpoch || '').trim();
  const metadata = {
    ...(delegation.metadata || {}),
    ...(delegation.workspace?.metadata || {}),
    ...(workspace?.metadata || {}),
    ...(remoteWorkspace?.metadata || {}),
  };
  const existingSessionId = String(workspace?.sessionId || delegation.sessionId || '').trim();
  let session = existingSessionId ? store.getSession(existingSessionId) : null;
  const existingEpoch = String(metadata.workspaceEpoch || '').trim();
  const valid = workspaceSessionIsValid(store, session, { userId: user.id, delegationId: delegation.id });
  const needsRepair = !valid || !existingEpoch || Boolean(localEpoch && remoteEpoch && localEpoch !== remoteEpoch);
  const workspaceEpoch = existingEpoch || newId('workspace_epoch');
  const previousWorkspaceSessionId = needsRepair
    ? (existingSessionId || String(metadata.previousWorkspaceSessionId || '').trim())
    : String(metadata.previousWorkspaceSessionId || '').trim();
  if (needsRepair) {
    session = store.createSession({
      title: delegation.title || 'uBuddy 任务工作区',
      departmentId: 'agent_delegation',
      agentId: 'secretary_agent',
      workspaceRoot,
      userId: user.id,
      accountWorkspaceId: delegation.workspaceId || delegation.accountWorkspaceId || '',
      reusePrimary: false,
    });
  } else if (workspaceRoot && String(session.workspaceRoot || '') !== String(workspaceRoot || '')) {
    session = store.updateSession(session.id, { workspaceRoot }) || session;
  }
  const nextMetadata = {
    ...metadata,
    workspaceEpoch,
    workspaceSessionId: session.id,
    ...(previousWorkspaceSessionId && previousWorkspaceSessionId !== session.id ? { previousWorkspaceSessionId } : {}),
    ...(needsRepair ? { workspaceRepairedAt: new Date().toISOString() } : {}),
  };
  auth.upsertDelegationWorkspace({
    delegationId: delegation.id,
    userId: user.id,
    sessionId: session.id,
    metadata: nextMetadata,
  });
  store.ensureTaskWorkspaceConversation?.({
    delegationId: delegation.id,
    ownerUserId: user.id,
    sessionId: session.id,
    taskRunId: delegation.taskRunId || delegation.task_run_id || '',
    groupId: delegation.groupId || delegation.group_id || metadata.groupId || '',
    workspaceRoot,
    workspaceEpoch,
    metadata: nextMetadata,
  });
  return {
    session,
    workspaceEpoch,
    previousWorkspaceSessionId: nextMetadata.previousWorkspaceSessionId || '',
    metadata: nextMetadata,
    repaired: needsRepair,
  };
}

function privateDelegationWorkspaceMessages(store, delegation = {}) {
  const delegationId = String(delegation.id || '').trim();
  const workspaceEpoch = delegationWorkspaceEpoch(delegation);
  const previousSessionId = delegationWorkspacePreviousSessionId(delegation);
  const currentSessionId = String(delegation.sessionId || '').trim();
  const current = currentSessionId ? store.listMessages(currentSessionId).filter((message) => (
    workspaceMessageBelongsToDelegation(message, delegationId, workspaceEpoch)
  )) : [];
  const legacy = previousSessionId && previousSessionId !== currentSessionId && store.getSession(previousSessionId)
    ? store.listMessages(previousSessionId).filter((message) => (
        workspaceMessageBelongsToDelegation(message, delegationId, workspaceEpoch, { allowLegacy: true })
      ))
    : [];
  return [...legacy, ...current].filter((message) => (
    !(message.role === 'user' && String(message.content || '').startsWith('\u3010\u597d\u53cb\u79d8\u4e66 Agent \u59d4\u6258\u4efb\u52a1\u3011'))
  ));
}

function mergeDelegationWorkspaceMessages(localMessages = [], remoteMessages = [], delegationId = '', workspaceEpoch = '') {
  const byId = new Map();
  const byLogicalId = new Set();
  const add = (message) => {
    const id = String(message.id || '');
    const logicalId = String(message.metadata?.localMessageId || id);
    if (!id || byId.has(id) || (logicalId && byLogicalId.has(logicalId))) return;
    byId.set(id, message);
    if (logicalId) byLogicalId.add(logicalId);
  };
  for (const message of localMessages) add(message);
  for (const message of Array.isArray(remoteMessages) ? remoteMessages : []) {
    if (!workspaceMessageBelongsToDelegation(message, delegationId, workspaceEpoch, { allowLegacy: true })) continue;
    add({
      id: String(message.id || ''),
      delegationId,
      sessionId: '',
      role: message.role || 'user',
      content: message.content || '',
      agentId: message.role === 'assistant' ? 'secretary_agent' : '',
      departmentId: 'agent_delegation',
      visible: true,
      metadata: { ...(message.metadata || {}), cloudPersisted: true },
      sourceEventId: message.sourceEventId || message.metadata?.sourceEventId || '',
      sourceGroupMessageId: message.sourceGroupMessageId || message.metadata?.sourceGroupMessageId || '',
      createdAt: message.createdAt || '',
      updatedAt: message.updatedAt || message.createdAt || '',
    });
  }
  return [...byId.values()].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id || '').localeCompare(String(right.id || '')));
}

async function syncDelegationWorkspaceMessages(socialRelay, delegationId = '', sessionId = '', messages = [], workspaceEpoch = '', workspaceId = '') {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.id || !String(message.content || '').trim()) continue;
    if (!workspaceMessageBelongsToDelegation(message, delegationId, workspaceEpoch)) continue;
    const metadata = sanitizeDelegationWorkspaceSyncValue(message.metadata || {});
    await socialRelay.sendDelegationWorkspaceMessage(delegationId, {
      workspaceId,
      clientMessageId: message.id,
      sessionId,
      role: message.role || 'user',
      content: message.content,
      metadata: { ...metadata, localMessageId: message.id },
      sourceEventId: message.sourceEventId || message.metadata?.sourceEventId || '',
      sourceGroupMessageId: message.sourceGroupMessageId || message.metadata?.sourceGroupMessageId || '',
    }).catch(() => null);
  }
}

function sanitizeDelegationWorkspaceSyncValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeDelegationWorkspaceSyncValue(item));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (LOCAL_ONLY_WORKSPACE_METADATA_KEYS.has(key)) continue;
    result[key] = sanitizeDelegationWorkspaceSyncValue(item);
  }
  return result;
}

export {
  delegationWorkspaceEpoch,
  ensureDelegationWorkspaceSession,
  mergeDelegationWorkspaceMessages,
  privateDelegationWorkspaceMessages,
  syncDelegationWorkspaceMessages,
  workspaceMessageBelongsToDelegation,
};
