export async function compressChatContextWithRefresh({
  api,
  sessionId = '',
  currentUsage = null,
  commandId = '',
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) throw new Error('缺少会话 ID。');
  const cleanCommandId = String(commandId || '').trim();
  let latestUsage = await api.chatContextStatus({ sessionId: cleanSessionId }).catch(() => currentUsage);
  const clear = () => api.clearChatContext({
    sessionId: cleanSessionId,
    commandId: cleanCommandId,
    expectedStateRevision: contextRevisionForSession(latestUsage, cleanSessionId),
  });
  try {
    return await clear();
  } catch (error) {
    if (!isChatContextStateConflict(error)) throw error;
    latestUsage = await api.chatContextStatus({ sessionId: cleanSessionId }).catch(() => null);
    if (!latestUsage) throw error;
    return clear();
  }
}

export const clearChatContextWithRefresh = compressChatContextWithRefresh;

export async function resetChatContextWithRefresh({
  api,
  sessionId = '',
  currentUsage = null,
  commandId = '',
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) throw new Error('缺少会话 ID。');
  const cleanCommandId = String(commandId || '').trim();
  let latestUsage = await api.chatContextStatus({ sessionId: cleanSessionId }).catch(() => currentUsage);
  const reset = () => api.resetChatContext({
    sessionId: cleanSessionId,
    commandId: cleanCommandId,
    expectedStateRevision: contextRevisionForSession(latestUsage, cleanSessionId),
  });
  try {
    return await reset();
  } catch (error) {
    if (!isChatContextStateConflict(error)) throw error;
    latestUsage = await api.chatContextStatus({ sessionId: cleanSessionId }).catch(() => null);
    if (!latestUsage) throw error;
    return reset();
  }
}

export async function resetPrivateAssistantContextWithRefresh({
  api,
  sessionId = '',
  currentUsage = null,
  commandId = '',
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) throw new Error('缺少会话 ID。');
  const cleanCommandId = String(commandId || '').trim();
  let latestUsage = await api.chatContextStatus({ sessionId: cleanSessionId }).catch(() => currentUsage);
  const reset = () => api.resetPrivateAssistantContext({
    sessionId: cleanSessionId,
    commandId: cleanCommandId,
    expectedStateRevision: contextRevisionForSession(latestUsage, cleanSessionId),
  });
  try {
    return await reset();
  } catch (error) {
    if (!isChatContextStateConflict(error)) throw error;
    latestUsage = await api.chatContextStatus({ sessionId: cleanSessionId }).catch(() => null);
    if (!latestUsage) throw error;
    return reset();
  }
}

export function isChatContextStateConflict(error) {
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
  const message = String(error?.message || error || '');
  return code === 'chat_context_state_conflict'
    || /chat_context_state_conflict|Chat context state changed on another device/i.test(message);
}

function contextRevisionForSession(usage, sessionId) {
  if (!usage || (usage.sessionId && usage.sessionId !== sessionId)) return null;
  return usage.stateRevision ?? null;
}
