export const TASK_CARD_ACTIONS = Object.freeze({
  OPEN_WORKSPACE: 'open_workspace',
  RETURN_TO_SOURCE_CHAT: 'return_to_source_chat',
  OPEN_FLOW_GRAPH: 'open_flow_graph',
  OPEN_RESULT: 'open_result',
  CANCEL_TASK: 'cancel_task',
});

export const TASK_CARD_ACTION_VALUES = Object.freeze(Object.values(TASK_CARD_ACTIONS));

export const PRIVATE_TASK_SOURCE_METADATA_KEYS = Object.freeze([
  'source_conversation_id',
  'sourceConversationId',
  'source_message_id',
  'sourceMessageId',
  'source_group_id',
  'sourceGroupId',
  'sourceSecretarySessionId',
  'sourceSecretaryMessageId',
]);

export function isTaskCardAction(value = '') {
  return TASK_CARD_ACTION_VALUES.includes(String(value || '').trim());
}

export function normalizeTaskSourceContext(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    source_conversation_id: cleanId(source.source_conversation_id || source.sourceConversationId || source.sourceSecretarySessionId),
    source_message_id: cleanId(source.source_message_id || source.sourceMessageId || source.sourceSecretaryMessageId),
    source_group_id: cleanId(source.source_group_id || source.sourceGroupId),
    task_workspace_id: cleanId(source.task_workspace_id || source.taskWorkspaceId || source.delegationId || source.delegation_id),
  };
}

export function privateTaskSourceMetadata(value = {}) {
  const context = taskSourceContextMetadata(value);
  return Object.fromEntries(PRIVATE_TASK_SOURCE_METADATA_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(context, key))
    .map((key) => [key, context[key]]));
}

export function withoutPrivateTaskSourceMetadata(value = {}) {
  const result = { ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  for (const key of PRIVATE_TASK_SOURCE_METADATA_KEYS) delete result[key];
  return result;
}

export function taskSourceContextMetadata(value = {}) {
  const context = normalizeTaskSourceContext(value);
  return {
    ...context,
    sourceConversationId: context.source_conversation_id,
    sourceMessageId: context.source_message_id,
    sourceGroupId: context.source_group_id,
    taskWorkspaceId: context.task_workspace_id,
  };
}

function cleanId(value = '') {
  return String(value || '').trim().slice(0, 240);
}
