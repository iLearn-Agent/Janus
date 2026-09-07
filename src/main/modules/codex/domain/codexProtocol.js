import { redactDiagnosticValue } from '../../../../shared/logging/redaction.js';

let codexStreamParserSequence = 0;

export function extractCodexThreadId(stdout) {
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      return event.thread_id;
    }
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (event.type === 'session_meta') {
      const sessionId = payload.session_id || payload.id;
      if (typeof sessionId === 'string' && sessionId) return sessionId;
    }
  }
  return null;
}

export function codexTokenUsage(value = {}) {
  const threadUsage = objectValue(value?.tokenUsage) || objectValue(value?.token_usage);
  const embeddedUsage = objectValue(value?.usage);
  const cumulativeSource = objectValue(threadUsage?.total)
    || objectValue(embeddedUsage?.total)
    || objectValue(value?.total);
  const lastSource = objectValue(threadUsage?.last)
    || objectValue(embeddedUsage?.last)
    || objectValue(value?.last)
    || objectValue(value?.lastTokenUsage)
    || objectValue(value?.last_token_usage);
  const candidates = [
    cumulativeSource,
    embeddedUsage,
    threadUsage,
    objectValue(value?.lastTokenUsage),
    objectValue(value?.last_token_usage),
    objectValue(value),
  ].filter(Boolean);
  const usage = candidates.map(normalizeTokenUsageItem).find(Boolean) || null;
  if (!usage) return null;

  const last = normalizeTokenUsageItem(lastSource);
  if (last) usage.last = last;
  usage.contextInputTokens = last
    ? last.inputTokens
    : cumulativeSource ? 0 : usage.inputTokens;
  usage.contextMeasurementState = last || !cumulativeSource ? 'available' : 'unknown';
  const modelContextWindow = positiveInteger(
    threadUsage?.modelContextWindow
    ?? threadUsage?.model_context_window
    ?? embeddedUsage?.modelContextWindow
    ?? embeddedUsage?.model_context_window
    ?? value?.modelContextWindow
    ?? value?.model_context_window
  );
  if (modelContextWindow > 0) usage.modelContextWindow = modelContextWindow;
  return usage;
}

function normalizeTokenUsageItem(item) {
  if (!item || typeof item !== 'object') return null;
  const inputTokens = positiveInteger(item.inputTokens ?? item.input_tokens ?? item.promptTokens ?? item.prompt_tokens);
  const outputTokens = positiveInteger(item.outputTokens ?? item.output_tokens ?? item.completionTokens ?? item.completion_tokens);
  const cachedInputTokens = positiveInteger(item.cachedInputTokens ?? item.cached_input_tokens ?? item.cacheReadInputTokens ?? item.cache_read_input_tokens);
  const cacheWriteInputTokens = positiveInteger(item.cacheWriteInputTokens ?? item.cache_write_input_tokens);
  const reasoningOutputTokens = positiveInteger(item.reasoningOutputTokens ?? item.reasoning_output_tokens);
  const totalTokens = positiveInteger(item.totalTokens ?? item.total_tokens) || inputTokens + outputTokens;
  if (totalTokens <= 0) return null;
  const usage = { inputTokens, outputTokens, cachedInputTokens, totalTokens };
  if (cacheWriteInputTokens > 0) usage.cacheWriteInputTokens = cacheWriteInputTokens;
  if (reasoningOutputTokens > 0) usage.reasoningOutputTokens = reasoningOutputTokens;
  return usage;
}

function objectValue(value) {
  return value && typeof value === 'object' ? value : null;
}

function assistantTextFromResponseItem(payload) {
  if (payload?.type !== 'message' || payload?.role !== 'assistant') return '';
  const parts = [];
  for (const item of payload.content || []) {
    if (!item || typeof item !== 'object') continue;
    if ((item.type === 'output_text' || item.type === 'text') && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.join('').trim();
}

export function stripProcessSummary(text) {
  return stripCodexProtocolJsonLines(String(text || ''))
    .replace(/\n?```(?:json)?\s*\{\s*"type"\s*:\s*"process_summary"[\s\S]*?```\s*$/i, '')
    .trim();
}

function stripCodexProtocolJsonLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((rawLine) => {
      const line = rawLine.trim();
      if (!line) return true;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      const protocolTypes = new Set([
        'thread.started',
        'turn.started',
        'turn.completed',
        'turn.failed',
        'item.started',
        'item.updated',
        'item.completed',
        'error',
        'session_meta',
        'response_item',
        'event_msg',
      ]);
      return !protocolTypes.has(event?.type);
    })
    .join('\n');
}

export function sanitizeProgress(text) {
  return stripProcessSummary(text);
}

function sanitizeUserVisibleAnswer(text) {
  return stripProcessSummary(text);
}

function normalizeProcessStatus(value = '', fallback = 'running') {
  const status = String(value || '').trim().toLowerCase().replaceAll('_', '');
  if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) return 'completed';
  if (['failed', 'error', 'errored'].includes(status)) return 'failed';
  if (['declined', 'cancelled', 'canceled', 'interrupted'].includes(status)) return 'cancelled';
  return fallback;
}

function optionalNumber(value, { integer = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number))) return null;
  return number;
}

function sanitizeProcessDetail(text = '') {
  return String(text || '').trim().replace(/\*\*([^*]+)\*\*/g, '$1');
}

function sanitizeProcessOutput(text = '') {
  return String(text || '');
}

export function sanitizeProcessProtocolValue(value) {
  return redactDiagnosticValue(value, { maxLength: 16_000 });
}

function commandProcessDetail(item = {}, detail = '') {
  const command = String(detail || item.command || item.cmd || '').trim();
  const skillAgent = command.replaceAll('\\', '/').match(/\/skills\/([^/]+)\/SKILL\.md/i)?.[1] || '';
  if (skillAgent) return `读取 ${skillAgent} 的 Skill`;
  if (/MEMORY\.md|memory\d*\.md/i.test(command)) return '读取当前 Memory';
  return sanitizeProcessDetail(command);
}

function safeFilename(value = '') {
  const clean = String(value || '').trim().replaceAll('\\', '/');
  return clean.split('/').filter(Boolean).at(-1) || '';
}

export function codexGeneratedImagePath(item = {}) {
  const type = String(item.type || '').replaceAll('_', '').toLowerCase();
  if (type !== 'imagegeneration') return '';
  return String(item.savedPath || item.saved_path || item.path || '').trim();
}

function reasoningSummary(item = {}) {
  const summaryText = reasoningSummaryParts(item).map((part) => part.text).join('\n\n');
  return sanitizeProcessDetail(summaryText || item.text || item.summary_text || '');
}

function reasoningSummaryParts(item = {}) {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary.map((part, index) => ({
    index,
    text: sanitizeProcessDetail(typeof part === 'string' ? part : part?.text || ''),
  })).filter((part) => part.text);
}

function normalizedReasoningSummaryParts(parts = []) {
  return (Array.isArray(parts) ? parts : []).map((part, index) => ({
    index: Number.isInteger(part?.index) ? part.index : index,
    text: sanitizeProcessDetail(typeof part === 'string' ? part : part?.text || ''),
  })).filter((part) => part.text).sort((left, right) => left.index - right.index);
}

function reasoningContent(item = {}) {
  const content = Array.isArray(item.content) ? item.content : [];
  return sanitizeProcessOutput(content.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('\n'));
}

function jsonValue(value) {
  return value === undefined ? null : value;
}

export function normalizeCodexFileChangeKind(change = {}) {
  const raw = change?.kind ?? change?.type ?? '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return String(raw.type || raw.kind || raw.operation || raw.value || '').trim();
  }
  return String(raw || '').trim();
}

export function normalizeCodexFileChangeDiff(change = {}) {
  const rawKind = change?.kind && typeof change.kind === 'object' && !Array.isArray(change.kind) ? change.kind : {};
  return String(change?.diff || change?.unified_diff || change?.content || rawKind.content || rawKind.diff || '');
}

function normalizedFileChanges(item = {}) {
  const workspaceRoot = String(item.workspaceRoot || item.workspace_root || '').replaceAll('\\', '/').replace(/\/+$/, '');
  return (Array.isArray(item.changes) ? item.changes : []).map((change) => {
    const filePath = String(change?.path || change?.file || '');
    const movePath = String(change?.movePath || change?.move_path || '');
    const normalizedPath = filePath.replaceAll('\\', '/');
    const normalizedMovePath = movePath.replaceAll('\\', '/');
    const relativePath = String(change?.relativePath || change?.relative_path || '').trim()
      || (workspaceRoot && normalizedPath.toLowerCase().startsWith(`${workspaceRoot.toLowerCase()}/`)
        ? normalizedPath.slice(workspaceRoot.length + 1)
        : '');
    return {
      path: filePath,
      relativePath,
      kind: normalizeCodexFileChangeKind(change),
      diff: normalizeCodexFileChangeDiff(change),
      movePath,
      moveRelativePath: String(change?.moveRelativePath || change?.move_relative_path || '').trim()
        || (workspaceRoot && normalizedMovePath.toLowerCase().startsWith(`${workspaceRoot.toLowerCase()}/`)
          ? normalizedMovePath.slice(workspaceRoot.length + 1)
          : ''),
      comparison: change?.comparison && typeof change.comparison === 'object' ? change.comparison : null,
    };
  });
}

function fileChangeDetail(item = {}) {
  const changes = normalizedFileChanges(item);
  const labels = changes.map((change) => {
    const filename = change.path || safeFilename(change.path);
    const action = String(change?.kind || change?.type || '').trim();
    return [action, filename].filter(Boolean).join(' · ');
  }).filter(Boolean);
  if (changes.length > labels.length) labels.push(`另有 ${changes.length - labels.length} 项`);
  return sanitizeProcessDetail(labels.join('\n'));
}

function processEvent({
  item = {},
  status = 'running',
  detail = '',
  append = false,
  output = '',
  appendOutput = false,
  reasoningText = '',
  appendReasoningText = false,
  summaryParts = null,
  stageOutput = null,
  terminalInput = '',
  appendTerminalInput = false,
  summaryIndex = null,
  startedAtMs = null,
  completedAtMs = null,
} = {}) {
  const rawType = String(item.type || '').trim();
  const type = rawType.replaceAll('_', '').toLowerCase();
  const activityId = protocolItemId(item) || `${rawType || 'activity'}-${Date.now()}`;
  const normalizedStatus = normalizeProcessStatus(item.status, status);
  if (type === 'reasoning') {
    const completedSummaryParts = reasoningSummaryParts(item);
    const projectedSummaryParts = normalizedReasoningSummaryParts(summaryParts);
    const resolvedSummaryParts = projectedSummaryParts.length ? projectedSummaryParts : completedSummaryParts;
    const reasoningDetail = sanitizeProcessDetail(
      resolvedSummaryParts.map((part) => part.text).join('\n\n') || detail || reasoningSummary(item),
    );
    const reasoningBody = sanitizeProcessOutput(reasoningText || reasoningContent(item));
    if (!reasoningDetail && !reasoningBody) return null;
    return {
      kind: 'activity', activityId, activityType: 'reasoning', status: normalizedStatus,
      title: '思考摘要', detail: reasoningDetail, append,
      reasoningText: reasoningBody, appendReasoningText,
      summaryParts: resolvedSummaryParts,
      summaryIndex: optionalNumber(summaryIndex, { integer: true }),
    };
  }
  if (type === 'commentary') {
    return {
      kind: 'activity', activityId, activityType: 'commentary', status: normalizedStatus,
      title: '执行说明', detail: sanitizeProcessDetail(detail || item.text || item.message || ''), append,
    };
  }
  if (type === 'agentmessage') {
    const phase = String(item.phase || '');
    const commentaryText = String(detail || item.text || item.message || '');
    return {
      kind: 'activity', activityId, activityType: phase === 'commentary' ? 'commentary' : 'answer',
      status: normalizedStatus,
      title: phase === 'commentary' ? '执行说明' : normalizedStatus === 'running' ? '正在生成回答' : '回答生成完成',
      detail: phase === 'commentary'
        ? sanitizeProcessDetail(commentaryText)
        : phase || 'agentMessage',
      append,
      stageOutput: false,
      responseText: sanitizeProcessOutput(item.text || item.message || detail || ''),
      memoryCitation: jsonValue(item.memoryCitation ?? item.memory_citation),
    };
  }
  if (type === 'hookprompt') {
    return {
      kind: 'activity', activityId, activityType: 'hook', status: normalizedStatus,
      title: 'Hook 提示注入', detail: sanitizeProcessDetail(detail), append,
      hookFragments: Array.isArray(item.fragments) ? item.fragments : [],
    };
  }
  if (type === 'commandexecution' || type === 'localshellcall') {
    const command = sanitizeProcessDetail(item.command || item.cmd || detail || '');
    const aggregatedOutput = output || item.aggregatedOutput || item.aggregated_output || item.output || '';
    const rawDurationMs = optionalNumber(item.durationMs ?? item.duration_ms);
    return {
      kind: 'activity', activityId, activityType: 'command', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在执行命令' : '命令执行',
      detail: commandProcessDetail(item, detail), append,
      command,
      cwd: sanitizeProcessDetail(item.cwd || ''),
      output: sanitizeProcessOutput(aggregatedOutput),
      appendOutput,
      terminalInput: sanitizeProcessOutput(terminalInput),
      appendTerminalInput,
      exitCode: optionalNumber(item.exitCode ?? item.exit_code, { integer: true }),
      durationMs: rawDurationMs === null ? null : Math.max(0, rawDurationMs),
      startedAtMs: optionalNumber(startedAtMs ?? item.startedAtMs ?? item.started_at_ms),
      completedAtMs: optionalNumber(completedAtMs ?? item.completedAtMs ?? item.completed_at_ms),
      processId: String(item.processId || item.process_id || ''),
      source: String(item.source || ''),
      commandActions: Array.isArray(item.commandActions)
        ? item.commandActions
        : Array.isArray(item.command_actions) ? item.command_actions : [],
    };
  }
  if (type === 'filechange' || type === 'applypatch') {
    const changes = normalizedFileChanges(item);
    return {
      kind: 'activity', activityId, activityType: 'file', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在处理文件' : '文件处理',
      detail: sanitizeProcessDetail(detail || fileChangeDetail(item)), append,
      changes,
      workspaceRoot: String(item.workspaceRoot || item.workspace_root || ''),
      diff: sanitizeProcessOutput(item.diff || changes.map((change) => change.diff).filter(Boolean).join('\n')),
    };
  }
  if (type === 'mcptoolcall' || type === 'dynamictoolcall') {
    const target = [item.server || item.namespace, item.tool || item.name].filter(Boolean).join(' / ');
    return {
      kind: 'activity', activityId, activityType: 'tool', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在调用工具' : '工具调用',
      detail: sanitizeProcessDetail(detail || target), append,
      toolServer: String(item.server || item.namespace || ''),
      toolName: String(item.tool || item.name || ''),
      arguments: jsonValue(item.arguments),
      result: jsonValue(item.result ?? item.contentItems ?? item.content_items),
      error: jsonValue(item.error),
      appContext: jsonValue(item.appContext ?? item.app_context),
      pluginId: String(item.pluginId || item.plugin_id || ''),
      mcpAppResourceUri: String(item.mcpAppResourceUri || item.mcp_app_resource_uri || ''),
      success: typeof item.success === 'boolean' ? item.success : null,
      durationMs: optionalNumber(item.durationMs ?? item.duration_ms),
    };
  }
  if (type === 'collabagenttoolcall' || type === 'subagentactivity') {
    const target = item.agentPath || item.agent_path || item.tool || '';
    return {
      kind: 'activity', activityId, activityType: 'agent', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在协调 Agent' : 'Agent 协作',
      detail: String(target || '').toLowerCase() === 'wait'
        ? '等待协作 Agent 返回结果'
        : sanitizeProcessDetail(detail || safeFilename(target)), append,
      agentTool: String(item.tool || item.kind || ''),
      senderThreadId: String(item.senderThreadId || item.sender_thread_id || ''),
      receiverThreadIds: Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
        : Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : [],
      agentThreadId: String(item.agentThreadId || item.agent_thread_id || ''),
      agentPath: String(item.agentPath || item.agent_path || ''),
      prompt: String(item.prompt || ''),
      model: String(item.model || ''),
      reasoningEffort: String(item.reasoningEffort || item.reasoning_effort || ''),
      agentsStates: jsonValue(item.agentsStates ?? item.agents_states),
    };
  }
  if (type === 'websearch') {
    return {
      kind: 'activity', activityId, activityType: 'search', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在检索资料' : '资料检索',
      detail: sanitizeProcessDetail(detail || item.query || ''), append,
      query: String(item.query || ''),
      searchAction: jsonValue(item.action),
      searchResults: jsonValue(item.results),
    };
  }
  if (type === 'imagegeneration' || type === 'imageview') {
    return {
      kind: 'activity', activityId, activityType: 'image', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在处理图像' : '图像处理',
      detail: sanitizeProcessDetail(detail || safeFilename(codexGeneratedImagePath(item) || item.path || '')), append,
      path: String(codexGeneratedImagePath(item) || item.path || ''),
      revisedPrompt: String(item.revisedPrompt || item.revised_prompt || ''),
      result: jsonValue(item.result),
    };
  }
  if (type === 'sleep') {
    return {
      kind: 'activity', activityId, activityType: 'wait', status: normalizedStatus,
      title: normalizedStatus === 'running' ? '正在等待' : '等待完成',
      detail: String(Math.max(0, Number(item.durationMs || item.duration_ms || 0))),
      durationMs: Math.max(0, Number(item.durationMs || item.duration_ms || 0)),
    };
  }
  if (type === 'enteredreviewmode' || type === 'exitedreviewmode') {
    return {
      kind: 'activity', activityId, activityType: 'review', status: normalizedStatus,
      title: type === 'enteredreviewmode' ? '进入审查模式' : '退出审查模式',
      detail: sanitizeProcessDetail(detail || item.review || ''),
      review: String(item.review || ''),
    };
  }
  if (type === 'contextcompaction') {
    return {
      kind: 'activity', activityId, activityType: 'context', status: normalizedStatus,
      title: normalizedStatus === 'completed' ? 'Codex 已整理上下文' : '正在整理上下文',
      detail: sanitizeProcessDetail(detail), append,
      providerCompactionDetected: normalizedStatus === 'completed',
    };
  }
  if (type === 'plan') {
    return {
      kind: 'activity', activityId, activityType: 'plan', status: normalizedStatus,
      title: '执行计划', detail: sanitizeProcessDetail(detail || item.text || ''), append,
    };
  }
  return {
    kind: 'activity', activityId, activityType: 'protocol', status: normalizedStatus,
    title: rawType || 'Codex 事件', detail: sanitizeProcessDetail(detail),
    itemType: rawType || 'unknown',
  };
}

export function codexProcessEventForItem(item = {}, options = {}) {
  const event = processEvent({ item, ...options });
  return event ? { ...event, eventOrigin: 'codex', nativeSource: options.nativeSource || 'codex_cli_jsonl' } : null;
}

function commentaryEvent(item = {}, text = '') {
  return codexProcessEventForItem(
    { id: protocolItemId(item), type: 'commentary', text },
    { status: 'completed' },
  );
}

function protocolItemId(item = {}) {
  return String(
    item.id
    || item.itemId
    || item.item_id
    || item.messageId
    || item.message_id
    || '',
  ).trim();
}

function legacyCommentaryPayload(rawLine = '') {
  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const commentary = event?.type === 'event_msg'
    ? payload.type === 'agent_message' && payload.phase === 'commentary'
    : event?.type === 'response_item' && payload.phase === 'commentary';
  if (!commentary || protocolItemId(payload)) return null;
  return payload;
}

export function createCodexStreamEventParser() {
  const parserId = ++codexStreamParserSequence;
  let commentarySequence = 0;
  let legacyCommentary = null;
  return (rawLine) => {
    const parsed = codexStreamEvent(rawLine);
    if (!parsed) return null;
    if (!legacyCommentaryPayload(rawLine) || parsed.kind !== 'activity' || parsed.activityType !== 'commentary') {
      return parsed;
    }
    const text = String(parsed.detail || '');
    if (!text) return parsed;
    if (legacyCommentary) {
      if (text === legacyCommentary.text || text.startsWith(legacyCommentary.text)) {
        legacyCommentary.text = text;
        return { ...parsed, activityId: legacyCommentary.activityId };
      }
      if (legacyCommentary.text.startsWith(text)) return null;
    }
    legacyCommentary = {
      activityId: `legacy-commentary-${parserId}-${++commentarySequence}`,
      text,
    };
    return { ...parsed, activityId: legacyCommentary.activityId };
  };
}

export function codexStreamEvent(rawLine) {
  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    return null;
  }
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const nativeEvent = (value) => value ? { ...value, eventOrigin: 'codex', nativeSource: 'codex_cli_jsonl' } : null;
  if (event.type === 'session_meta') {
    const sessionId = payload.session_id || payload.id;
    if (typeof sessionId === 'string' && sessionId) return { kind: 'thread', threadId: sessionId };
  }
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return { kind: 'thread', threadId: event.thread_id };
  }
  if (event.type === 'item.started') {
    return codexProcessEventForItem(event.item || {}, { status: 'running' });
  }
  if (event.type === 'item.completed') {
    const item = event.item || {};
    const itemType = String(item.type || '').replaceAll('_', '').toLowerCase();
    if (itemType === 'agentmessage') {
      const text = String(item.text || item.message || '').trim();
      if (!text) return null;
      if (item.phase === 'commentary') {
        return nativeEvent(commentaryEvent(item, text));
      }
      return nativeEvent({ kind: 'answer', content: sanitizeUserVisibleAnswer(text) });
    }
    return codexProcessEventForItem(item, { status: 'completed' });
  }
  if (event.type === 'item.updated') {
    return codexProcessEventForItem(event.item || {}, { status: 'running' });
  }
  if (event.type === 'turn.failed') {
    return nativeEvent({ kind: 'error', message: sanitizeProcessDetail(event.error?.message || event.message || 'Codex turn failed.') });
  }
  if (event.type === 'turn.completed') {
    const usage = codexTokenUsage(event);
    return nativeEvent(usage ? { kind: 'usage', usage } : null);
  }
  if (event.type === 'response_item') {
    const text = assistantTextFromResponseItem(payload);
    if (payload.phase === 'commentary' && text) {
      return nativeEvent(commentaryEvent(payload, text));
    }
    if (payload.phase === 'final_answer' && text) return nativeEvent({ kind: 'answer', content: stripProcessSummary(text) });
    return null;
  }
  if (event.type !== 'event_msg') return null;
  if (payload.type === 'agent_message') {
    const text = String(payload.message || '').trim();
    if (payload.phase === 'commentary' && text) {
      return nativeEvent(commentaryEvent(payload, text));
    }
    if (payload.phase === 'final_answer' && text) return nativeEvent({ kind: 'answer', content: stripProcessSummary(text) });
  }
  if (['agent_message_delta', 'agent_message_token'].includes(payload.type)) {
    const text = String(payload.delta || payload.content || payload.message || '');
    if (payload.phase === 'final_answer' && text) return nativeEvent({ kind: 'token', content: sanitizeUserVisibleAnswer(text) });
  }
  if (payload.type === 'task_complete') {
    const text = String(payload.last_agent_message || '').trim();
    if (text) return nativeEvent({ kind: 'complete', answer: stripProcessSummary(text) });
  }
  return null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
