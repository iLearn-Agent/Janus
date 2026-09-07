export function mergeTaskWorkspaceSnapshot(previous = null, incoming = null, mergeTask = defaultTaskMerge) {
  if (!incoming) return previous;
  if (!previous || String(previous.id || '') !== String(incoming.id || '')) return incoming;
  const merged = mergeTask(previous, incoming) || incoming;
  const preserveArray = (key) => Array.isArray(incoming[key]) && incoming[key].length
    ? incoming[key] : Array.isArray(previous[key]) ? previous[key] : incoming[key];
  return {
    ...merged,
    metadata: { ...(previous.metadata || {}), ...(incoming.metadata || {}) },
    nodes: preserveArray('nodes'),
    events: incoming.eventHistoryPartial
      ? mergeTaskWorkspaceEvents(previous.events, merged.events || incoming.events)
      : preserveArray('events'),
    communications: preserveArray('communications'),
    deliverySubmissions: preserveArray('deliverySubmissions'),
  };
}

function mergeTaskWorkspaceEvents(previous = [], incoming = []) {
  const merged = new Map();
  const append = (event, index, source) => {
    const key = String(event?.id || event?.eventId || `${source}:${index}`);
    merged.set(key, { ...(merged.get(key) || {}), ...(event || {}) });
  };
  (Array.isArray(previous) ? previous : []).forEach((event, index) => append(event, index, 'previous'));
  (Array.isArray(incoming) ? incoming : []).forEach((event, index) => append(event, index, 'incoming'));
  return [...merged.values()].sort((left, right) => (
    String(left?.createdAt || left?.created_at || '').localeCompare(String(right?.createdAt || right?.created_at || ''))
    || String(left?.id || left?.eventId || '').localeCompare(String(right?.id || right?.eventId || ''))
  ));
}

export function mergeTaskWorkspaceMessages(previous = [], incoming = []) {
  const prior = Array.isArray(previous) ? previous : [];
  const next = Array.isArray(incoming) ? incoming : [];
  if (!next.length) return prior;
  const merged = new Map(prior.map((message, index) => [String(message?.id || `previous:${index}`), message]));
  next.forEach((message, index) => {
    const key = String(message?.id || `incoming:${index}`);
    merged.set(key, { ...(merged.get(key) || {}), ...message });
  });
  return [...merged.values()].sort((left, right) => (
    String(left?.createdAt || left?.created_at || '').localeCompare(String(right?.createdAt || right?.created_at || ''))
    || String(left?.id || '').localeCompare(String(right?.id || ''))
  ));
}

function defaultTaskMerge(previous, incoming) {
  return { ...previous, ...incoming };
}
