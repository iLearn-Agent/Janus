import { normalizeMentionEntities } from '../../../../shared/contracts/mentions.js';
import { normalizeMessageQuote } from '../../../../shared/contracts/messageQuote.js';

const PERSISTED_DRAFT_VERSION = 2;

export function composerSurfaceKey(state = {}) {
  if (state.chatGroupId) return `chat-group:${state.chatGroupId}`;
  if (state.collaborationGroupId) return `collaboration:${state.collaborationGroupId}`;
  if (state.networkConversationPeerId && state.networkConversationPeerId !== 'self-secretary') {
    return state.networkConversationMode === 'group'
      ? `social-group:${state.networkConversationPeerId}:${state.networkConversationGroupId || 'legacy'}`
      : `social-direct:${state.networkConversationPeerId}`;
  }
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
  if (state.homeMode === 'secretary' || session?.departmentId === 'secretary_department'
    || String(state.currentChatKey || '').startsWith('ubuddy:')) return 'ubuddy';
  if (state.homeMode === 'private_assistant' || session?.departmentId === 'private_assistant') {
    return 'private-assistant';
  }
  if (state.currentAgentInstanceId) return `agent:${state.currentAgentInstanceId}`;
  if (state.currentSessionId) return `session:${state.currentSessionId}`;
  const chatKey = String(state.currentChatKey || '').trim();
  return chatKey ? `new:${chatKey}` : '';
}

export function migrateComposerDrafts(value = {}) {
  const migrated = normalizeDraftMap(value.composerDraftsBySurface || value.draftsBySurface || {});
  for (const [agentInstanceId, text] of Object.entries(value.agentConversationDrafts || {})) {
    addLegacyText(migrated, `agent:${agentInstanceId}`, text);
  }
  for (const [legacyKey, text] of Object.entries(value.networkConversationDrafts || {})) {
    addLegacyText(migrated, migrateNetworkDraftKey(legacyKey), text);
  }
  return migrated;
}

export function createComposerDraftController({
  state,
  readInputValue = () => null,
  persist = () => {},
} = {}) {
  const runtimeAttachments = new Map();

  function hydrate(value = {}) {
    state.composerDraftsBySurface = migrateComposerDrafts(value);
    state.composerDraftsVersion = PERSISTED_DRAFT_VERSION;
    return state.composerDraftsBySurface;
  }

  function capture(key = composerSurfaceKey(state), { persistAfter = true, readInput = true } = {}) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return '';
    const inputValue = readInput ? readInputValue() : null;
    const text = String(inputValue == null ? state.chatDraft || '' : inputValue);
    state.chatDraft = text;
    const snapshot = normalizeDraftSnapshot({
      text,
      mentions: state.composerMentions,
      secretaryMentions: state.secretaryMentions,
      fileReferences: state.composerFileReferences,
      memoryReferences: state.composerMemoryReferences,
      quote: state.messageQuote,
      taskReference: state.composerTaskReference,
      participantSelectionPolicy: state.uBuddyParticipantSelectionPolicy,
    });
    const next = { ...(state.composerDraftsBySurface || {}) };
    if (draftHasSafeContent(snapshot)) next[cleanKey] = snapshot;
    else delete next[cleanKey];
    state.composerDraftsBySurface = next;
    const attachments = Array.isArray(state.attachments) ? [...state.attachments] : [];
    if (attachments.length) runtimeAttachments.set(cleanKey, attachments);
    else runtimeAttachments.delete(cleanKey);
    if (persistAfter) persist();
    return text;
  }

  function restore(key = composerSurfaceKey(state), { fallbackText = '' } = {}) {
    const cleanKey = String(key || '').trim();
    const snapshot = normalizeDraftSnapshot(state.composerDraftsBySurface?.[cleanKey] || { text: fallbackText });
    const text = snapshot.text || String(fallbackText || '');
    state.chatDraft = text;
    state.composerMentions = normalizeMentionEntities(snapshot.mentions, { content: text, requirePicker: true });
    state.secretaryMentions = cleanKey === 'ubuddy'
      ? normalizeMentionEntities(snapshot.secretaryMentions, { content: text, requirePicker: true })
      : [];
    state.composerFileReferences = validFileReferences(snapshot.fileReferences, state);
    state.composerMemoryReferences = validMemoryReferences(snapshot.memoryReferences);
    state.messageQuote = validQuote(snapshot.quote, cleanKey);
    state.composerTaskReference = cleanKey === 'ubuddy' ? validTaskReference(snapshot.taskReference, state) : null;
    state.uBuddyParticipantSelectionPolicy = cleanKey === 'ubuddy'
      && snapshot.participantSelectionPolicy === 'all_mentioned' ? 'all_mentioned' : 'auto_select';
    state.attachments = [...(runtimeAttachments.get(cleanKey) || [])];
    return text;
  }

  function clear(key = composerSurfaceKey(state), { applyToCurrent = true } = {}) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return;
    const next = { ...(state.composerDraftsBySurface || {}) };
    delete next[cleanKey];
    state.composerDraftsBySurface = next;
    runtimeAttachments.delete(cleanKey);
    if (applyToCurrent && composerSurfaceKey(state) === cleanKey) applyEmptyDraft(state);
    persist();
  }

  function clearRuntime() {
    runtimeAttachments.clear();
  }

  function snapshot(key = composerSurfaceKey(state)) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return null;
    const draft = state.composerDraftsBySurface?.[cleanKey];
    if (!draft && !runtimeAttachments.has(cleanKey)) return null;
    return {
      draft: normalizeDraftSnapshot(draft || {}),
      attachments: [...(runtimeAttachments.get(cleanKey) || [])],
    };
  }

  function put(key, value = null, { persistAfter = true } = {}) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey || !value) return false;
    const draft = normalizeDraftSnapshot(value.draft || value);
    const next = { ...(state.composerDraftsBySurface || {}) };
    if (draftHasSafeContent(draft)) next[cleanKey] = draft;
    else delete next[cleanKey];
    state.composerDraftsBySurface = next;
    const attachments = Array.isArray(value.attachments) ? [...value.attachments] : [];
    if (attachments.length) runtimeAttachments.set(cleanKey, attachments);
    else runtimeAttachments.delete(cleanKey);
    if (persistAfter) persist();
    return true;
  }

  function has(key = composerSurfaceKey(state)) {
    const cleanKey = String(key || '').trim();
    return Boolean(cleanKey && (state.composerDraftsBySurface?.[cleanKey] || runtimeAttachments.has(cleanKey)));
  }

  return { capture, clear, clearRuntime, has, hydrate, put, restore, snapshot, surfaceKey: () => composerSurfaceKey(state) };
}

function normalizeDraftMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, draft]) => [String(key || '').trim(), normalizeDraftSnapshot(draft)])
    .filter(([key, draft]) => key && draftHasSafeContent(draft)));
}

function normalizeDraftSnapshot(value = {}) {
  const source = typeof value === 'string' ? { text: value } : value && typeof value === 'object' ? value : {};
  return {
    version: PERSISTED_DRAFT_VERSION,
    text: String(source.text || '').slice(0, 1_000_000),
    mentions: objectArray(source.mentions, 100),
    secretaryMentions: objectArray(source.secretaryMentions, 100),
    fileReferences: objectArray(source.fileReferences, 100),
    memoryReferences: objectArray(source.memoryReferences, 100),
    quote: source.quote && typeof source.quote === 'object' ? { ...source.quote } : null,
    taskReference: source.taskReference && typeof source.taskReference === 'object' ? { ...source.taskReference } : null,
    participantSelectionPolicy: source.participantSelectionPolicy === 'all_mentioned' ? 'all_mentioned' : 'auto_select',
  };
}

function objectArray(value, limit) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').slice(0, limit).map((item) => ({ ...item })) : [];
}

function draftHasSafeContent(draft = {}) {
  return Boolean(draft.text || draft.mentions?.length || draft.secretaryMentions?.length
    || draft.fileReferences?.length || draft.memoryReferences?.length || draft.quote || draft.taskReference);
}

function addLegacyText(target, key, text) {
  const cleanKey = String(key || '').trim();
  const cleanText = String(text || '');
  if (!cleanKey || !cleanText || target[cleanKey]) return;
  target[cleanKey] = normalizeDraftSnapshot({ text: cleanText });
}

function migrateNetworkDraftKey(key = '') {
  const clean = String(key || '').trim();
  if (clean.startsWith('chat-group:') || clean.startsWith('collaboration:')) return clean;
  const group = clean.match(/^(.*):group:(.*)$/);
  if (group) return `social-group:${group[1]}:${group[2] || 'legacy'}`;
  const direct = clean.match(/^(.*):person$/);
  if (direct) return `social-direct:${direct[1]}`;
  return '';
}

function validFileReferences(values = [], state = {}) {
  const projects = new Set((state.projects || []).map((item) => String(item.id || '')));
  const activeProjectId = String(state.activeProjectId || '').trim();
  return objectArray(values, 100).filter((item) => {
    const projectId = String(item.projectId || '').trim();
    return projectId && (!projects.size || projects.has(projectId)) && (!activeProjectId || projectId === activeProjectId);
  });
}

function validMemoryReferences(values = []) {
  return objectArray(values, 100).filter((item) => String(item.sourceMemoryId || '').trim());
}

function validQuote(value, surfaceKey) {
  const quote = normalizeMessageQuote(value);
  if (!quote) return null;
  const expected = surfaceConversationId(surfaceKey);
  return !quote.sourceConversationId || !expected || quote.sourceConversationId === expected ? quote : null;
}

function validTaskReference(value, state = {}) {
  if (!value || typeof value !== 'object') return null;
  if (value.createNewTask) return { ...value };
  const taskRunId = String(value.taskRunId || value.task_run_id || '').trim();
  if (!taskRunId) return null;
  if ((state.tasks || []).length && !(state.tasks || []).some((item) => String(item.id || item.taskRunId || '') === taskRunId)) return null;
  return { ...value };
}

function surfaceConversationId(key = '') {
  if (key.startsWith('chat-group:') || key.startsWith('collaboration:')) return key;
  if (key.startsWith('social-direct:')) return `direct:${key.slice('social-direct:'.length)}`;
  if (key.startsWith('social-group:')) return key;
  if (key.startsWith('session:')) return key;
  return '';
}

function applyEmptyDraft(state) {
  state.chatDraft = '';
  state.attachments = [];
  state.composerMentions = [];
  state.secretaryMentions = [];
  state.composerFileReferences = [];
  state.composerMemoryReferences = [];
  state.messageQuote = null;
  state.composerTaskReference = null;
  state.uBuddyParticipantSelectionPolicy = 'auto_select';
}
