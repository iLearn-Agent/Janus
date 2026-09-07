import fs from 'node:fs';
import path from 'node:path';

import { codexTokenUsage } from './modules/codex/domain/codexProtocol.js';
import { privateAssistantTextUsageSince, recordModelTokenUsage } from './managedProviderUsage.js';
import { dataDir } from './paths.js';

export const PRIVATE_ASSISTANT_AGENT_ID = 'private_assistant';
export const PRIVATE_ASSISTANT_DEPARTMENT_ID = 'private_assistant';
export const DEFAULT_PRIVATE_ASSISTANT_WEEKLY_TOKEN_LIMIT = 20_000_000;

export function privateAssistantPermissionMode(value = '') {
  return ['request-approval', 'task-workspace'].includes(String(value || '').trim())
    ? String(value).trim()
    : 'request-approval';
}

export function privateAssistantWeeklyTokenLimit(env = process.env) {
  const configured = Number(env.JANUS_PRIVATE_ASSISTANT_WEEKLY_TOKENS);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.floor(configured)
    : DEFAULT_PRIVATE_ASSISTANT_WEEKLY_TOKEN_LIMIT;
}

export function privateAssistantWeekWindow(now = new Date()) {
  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const shifted = new Date(current.getTime() + 8 * 60 * 60 * 1000);
  const weekday = shifted.getUTCDay() || 7;
  const startMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - weekday + 1)
    - 8 * 60 * 60 * 1000;
  const resetMs = startMs + 7 * 24 * 60 * 60 * 1000;
  const beijingStart = new Date(startMs + 8 * 60 * 60 * 1000);
  const key = [beijingStart.getUTCFullYear(), String(beijingStart.getUTCMonth() + 1).padStart(2, '0'), String(beijingStart.getUTCDate()).padStart(2, '0')].join('-');
  return { key, startAt: new Date(startMs).toISOString(), resetAt: new Date(resetMs).toISOString() };
}

export function privateAssistantUsageStatus(store, userId = '', {
  now = new Date(),
  limit = privateAssistantWeeklyTokenLimit(),
} = {}) {
  const cleanUserId = safeSegment(userId || 'local_user');
  const window = privateAssistantWeekWindow(now);
  const legacyUsed = storedNonNegativeInteger(store, usageSettingKey(cleanUserId, window.key));
  const storedText = store?.settingGet?.(usageTextSettingKey(cleanUserId, window.key), '');
  const imageEquivalentUsed = storedNonNegativeInteger(store, usageImageEquivalentSettingKey(cleanUserId, window.key));
  const legacyTextUsed = storedText === '' || storedText == null
    ? Math.max(0, legacyUsed - imageEquivalentUsed)
    : Math.max(0, Number(storedText) || 0);
  const ledgerTextUsed = privateAssistantTextUsageSince(store, cleanUserId, window.startAt);
  const textUsed = legacyTextUsed + ledgerTextUsed;
  const imageCount = storedNonNegativeInteger(store, usageImageCountSettingKey(cleanUserId, window.key));
  const used = textUsed;
  const safeLimit = Math.max(1_000, Number(limit) || DEFAULT_PRIVATE_ASSISTANT_WEEKLY_TOKEN_LIMIT);
  const remaining = Math.max(0, safeLimit - used);
  const last = store?.db?.prepare?.(`SELECT raw_total_tokens,input_tokens,output_tokens,cached_input_tokens,usage_source
    FROM managed_provider_usage_events WHERE user_id=? AND private_assistant=1 AND occurred_at>=?
      AND usage_source NOT LIKE 'image_%'
    ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`).get(cleanUserId, window.startAt) || null;
  return {
    agentId: PRIVATE_ASSISTANT_AGENT_ID,
    departmentId: PRIVATE_ASSISTANT_DEPARTMENT_ID,
    localOnly: true,
    quotaExempt: true,
    weeklyTokenLimit: safeLimit,
    weeklyTokensUsed: used,
    weeklyTextTokensUsed: textUsed,
    weeklyImageTokensUsed: imageEquivalentUsed,
    weeklyImageEquivalentTokensUsed: imageEquivalentUsed,
    weeklyImageCount: imageCount,
    weeklyTokensRemaining: remaining,
    usagePercent: Number(Math.min(100, (used / safeLimit) * 100).toFixed(2)),
    exhausted: remaining <= 0,
    weekStartAt: window.startAt,
    resetAt: window.resetAt,
    lastTurnTokens: Math.max(0, Number(last?.raw_total_tokens) || 0),
    lastTurnInputTokens: Math.max(0, Number(last?.input_tokens) || 0),
    lastTurnOutputTokens: Math.max(0, Number(last?.output_tokens) || 0),
    lastTurnCachedInputTokens: Math.max(0, Number(last?.cached_input_tokens) || 0),
    usageSource: String(last?.usage_source || ''),
  };
}

export function recordPrivateAssistantUsage(store, userId = '', usage = {}, options = {}) {
  const normalized = normalizeTokenUsage(usage);
  const consumed = Math.max(0, normalized.totalTokens);
  if (consumed > 0 && options.eventKey) {
    recordModelTokenUsage(store, {
      root: options.root || '',
      userId,
      accountWorkspaceId: options.accountWorkspaceId || '',
      executionId: options.executionId || '',
      sessionId: options.sessionId || '',
      threadId: options.threadId || '',
      turnId: options.turnId || '',
      eventKey: options.eventKey,
      agentId: PRIVATE_ASSISTANT_AGENT_ID,
      model: options.model || '',
      reasoningEffort: options.reasoningEffort || '',
      usage: normalized,
      privateAssistant: true,
      usageSource: normalized.source === 'estimated' ? 'estimated' : 'provider_last',
      occurredAt: (options.now || new Date()).toISOString(),
    });
  } else if (consumed > 0 && !store?.db) {
    const before = privateAssistantUsageStatus(store, userId, options);
    const week = privateAssistantWeekWindow(options.now || new Date());
    const cleanUserId = safeSegment(userId || 'local_user');
    const nextTextUsed = before.weeklyTextTokensUsed + consumed;
    store?.settingSet?.(usageTextSettingKey(cleanUserId, week.key), String(nextTextUsed));
    store?.settingSet?.(usageSettingKey(cleanUserId, week.key), String(nextTextUsed));
  }
  return {
    ...privateAssistantUsageStatus(store, userId, options),
    lastTurnTokens: consumed,
    lastTurnInputTokens: normalized.inputTokens,
    lastTurnOutputTokens: normalized.outputTokens,
    lastTurnCachedInputTokens: normalized.cachedInputTokens,
    usageSource: normalized.source,
  };
}

export function normalizeTokenUsage(value = {}) {
  const normalized = codexTokenUsage(value);
  if (normalized) {
    const turn = normalized.last || normalized;
    const sourceValue = String(turn.source || normalized.source || value?.source || '').trim();
    return {
      ...turn,
      contextInputTokens: normalized.contextInputTokens,
      contextMeasurementState: normalized.contextMeasurementState,
      source: sourceValue === 'estimated' ? 'estimated' : 'provider',
    };
  }
  return {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
    contextInputTokens: 0, contextMeasurementState: 'unknown', source: 'unknown',
  };
}

export function estimatedPrivateAssistantUsage(prompt = '', answer = '') {
  const inputTokens = estimateTextTokens(prompt);
  const outputTokens = estimateTextTokens(answer);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    totalTokens: inputTokens + outputTokens,
    contextInputTokens: inputTokens,
    contextMeasurementState: 'available',
    source: 'estimated',
  };
}

export function resolvePrivateAssistantTurnUsage(result = {}, prompt = '', answer = '') {
  const providerUsage = normalizeTokenUsage(result?.usage || result);
  return providerUsage.totalTokens > 0 && providerUsage.contextMeasurementState === 'available'
    ? providerUsage
    : estimatedPrivateAssistantUsage(prompt, answer);
}

export function privateAssistantWorkspace(root, userId = '') {
  const directory = path.join(dataDir(root), 'private_assistant', safeSegment(userId || 'local_user'));
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function buildPrivateAssistantPrompt({ userMessage = '', recentMessages = [], attachmentContext = '' } = {}) {
  const history = (recentMessages || [])
    .filter((item) => ['user', 'assistant'].includes(item?.role))
    .slice(-20)
    .map((item) => `${String(item.role).toUpperCase()}: ${String(item.content || '').slice(0, 4000)}`)
    .join('\n\n');
  return `You are the user's isolated private assistant inside Janus.

Privacy and isolation rules:
- Work only with this private conversation and files the user explicitly attached to this turn.
- Never delegate, spawn, mention, message, route to, or request information from any other Agent.
- Never read or use other Janus conversations, Agent Memory, employee state, social messages, collaboration tasks, cloud data, or organization context.
- Do not use web search, network tools, MCP tools, or external services. The configured model provider is used only to generate this reply.
- Do not create durable Codex Memories or evolution evidence.
- Janus Plugin and standalone Skill installation is host-governed. Never use skill-installer, Shell, git clone, or edit CODEX_HOME/config files as an installation fallback.
- Treat the dedicated private workspace as the only filesystem boundary. Never access anything outside it; the user must explicitly attach a file to make it available.
- Do not suggest sharing or uploading private content unless the user explicitly asks.

Recent private conversation:
${history || 'No earlier private messages.'}

${String(attachmentContext || '').trim() ? `Files explicitly attached by the user for this turn:\n${String(attachmentContext).trim()}\n` : ''}
Current user message:
${String(userMessage || '').trim()}`;
}

export function isPrivateAssistantDepartment(departmentId = '') {
  return String(departmentId || '') === PRIVATE_ASSISTANT_DEPARTMENT_ID;
}

function usageSettingKey(userId, weekKey) {
  return `private_assistant:usage:${userId}:${weekKey}`;
}

function usageTextSettingKey(userId, weekKey) {
  return `${usageSettingKey(userId, weekKey)}:text`;
}

function usageImageEquivalentSettingKey(userId, weekKey) {
  return `${usageSettingKey(userId, weekKey)}:image_equivalent`;
}

function usageImageCountSettingKey(userId, weekKey) {
  return `${usageSettingKey(userId, weekKey)}:image_count`;
}

function storedNonNegativeInteger(store, key) {
  return Math.max(0, Number(store?.settingGet?.(key, '0')) || 0);
}

function estimateTextTokens(value = '') {
  const text = String(value || '');
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
  const nonCjk = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, '');
  return Math.max(0, cjk + Math.ceil(nonCjk.length / 4));
}

function safeSegment(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'local_user';
}
