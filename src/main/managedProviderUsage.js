import { codexConfigStatus } from './codexConfig.js';
import {
  MANAGED_IMAGE_PROVIDER_SCOPE_ID,
  customImageProviderScopeId,
  imageGenerationProviderState,
} from './imageProvider.js';
import { codexTokenUsage } from './modules/codex/domain/codexProtocol.js';
import { newId, sha256Text } from './utils.js';

export const DEFAULT_MANAGED_PROVIDER_DAILY_TOKEN_LIMIT = 20_000_000;
export const DEFAULT_DAILY_IMAGE_GENERATION_LIMIT = 5;
export const MANAGED_PROVIDER_QUOTA_TIMEZONE = 'Asia/Shanghai';
const IMAGE_QUOTA_USAGE_SOURCE = 'image_quota_v1';
const CUSTOM_IMAGE_USAGE_SOURCE = 'image_usage_unlimited_v2';

export class ManagedProviderQuotaExceeded extends Error {
  constructor(status = {}) {
    super(`default_model_daily_limit: 今日默认模型服务 Token 额度已用完，将于 ${new Date(status.resetAt || Date.now()).toLocaleString('zh-CN', { timeZone: MANAGED_PROVIDER_QUOTA_TIMEZONE })} 重置。`);
    this.name = 'ManagedProviderQuotaExceeded';
    this.code = 'default_model_daily_limit';
    this.usage = status;
  }
}

export class ImageGenerationQuotaExceeded extends Error {
  constructor(status = {}) {
    super(`image_generation_daily_limit: Daily image limit reached (${status.dailyImagesUsed || 0}/${status.dailyImageLimit || DEFAULT_DAILY_IMAGE_GENERATION_LIMIT}); available again at 00:00 Beijing Time. 今日图片生成额度已用完，将于北京时间 00:00 重置。`);
    this.name = 'ImageGenerationQuotaExceeded';
    this.code = 'image_generation_daily_limit';
    this.usage = status;
  }
}

export function managedProviderDailyTokenLimit(env = process.env) {
  const configured = Number(env.JANUS_MANAGED_PROVIDER_DAILY_TOKEN_LIMIT);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.floor(configured)
    : DEFAULT_MANAGED_PROVIDER_DAILY_TOKEN_LIMIT;
}

export function managedProviderQuotaMode(env = process.env) {
  return String(env.JANUS_MANAGED_PROVIDER_QUOTA_MODE || 'enforce').trim().toLowerCase() === 'observe'
    ? 'observe'
    : 'enforce';
}

export function dailyImageGenerationLimit(env = process.env) {
  const configured = Number(env.JANUS_DAILY_IMAGE_GENERATION_LIMIT);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_DAILY_IMAGE_GENERATION_LIMIT;
}

export function beijingQuotaDayWindow(now = new Date()) {
  const value = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const key = [year, String(month + 1).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  const startMs = Date.UTC(year, month, day) - 8 * 60 * 60 * 1000;
  const resetMs = Date.UTC(year, month, day + 1) - 8 * 60 * 60 * 1000;
  return { key, startAt: new Date(startMs).toISOString(), resetAt: new Date(resetMs).toISOString() };
}

export function isManagedProviderSource(source = '') {
  return ['embedded', 'development'].includes(String(source || '').trim());
}

export function modelUsageProviderState(root = '') {
  const config = codexConfigStatus(root);
  const managedProvider = isManagedProviderSource(config.credentialSource);
  return {
    config,
    managedProvider,
    providerScopeId: managedProvider
      ? 'janus_default_model_service_v1'
      : `custom_provider:${sha256Text(`${config.providerName || ''}\n${config.baseUrl || ''}`).slice(0, 24)}`,
  };
}

export function managedProviderUsageStatus(store, userId = '', {
  root = '',
  now = new Date(),
  limit = managedProviderDailyTokenLimit(),
  providerState = null,
  imageProviderState = null,
} = {}) {
  const resolvedProvider = providerState || modelUsageProviderState(root);
  const window = beijingQuotaDayWindow(now);
  const cleanUserId = String(userId || 'local_admin').trim() || 'local_admin';
  const row = store?.db?.prepare?.(`SELECT
      COALESCE(SUM(charged_tokens),0) AS charged_tokens,
      COALESCE(SUM(raw_total_tokens),0) AS raw_total_tokens,
      COUNT(*) AS event_count
    FROM managed_provider_usage_events
    WHERE user_id=? AND provider_scope_id=? AND quota_day=?
      AND usage_source NOT LIKE 'image_api_%' AND usage_source<> '${IMAGE_QUOTA_USAGE_SOURCE}'`).get(
      cleanUserId, resolvedProvider.providerScopeId, window.key,
    ) || {};
  const allProviderRow = store?.db?.prepare?.(`SELECT
      COALESCE(SUM(raw_total_tokens),0) AS raw_total_tokens,COUNT(*) AS event_count
    FROM managed_provider_usage_events WHERE user_id=? AND quota_day=?
      AND usage_source NOT LIKE 'image_api_%' AND usage_source<> '${IMAGE_QUOTA_USAGE_SOURCE}'`).get(cleanUserId, window.key) || {};
  const last = store?.db?.prepare?.(`SELECT * FROM managed_provider_usage_events
    WHERE user_id=? AND provider_scope_id=? AND quota_day=?
      AND usage_source NOT LIKE 'image_api_%' AND usage_source<> '${IMAGE_QUOTA_USAGE_SOURCE}'
      AND usage_source<> '${CUSTOM_IMAGE_USAGE_SOURCE}'
    ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`).get(
    cleanUserId, resolvedProvider.providerScopeId, window.key,
  ) || null;
  const chargedTokensUsed = Math.max(0, Number(row.charged_tokens) || 0);
  const providerTokensUsed = resolvedProvider.managedProvider
    ? chargedTokensUsed
    : Math.max(0, Number(row.raw_total_tokens) || 0);
  const safeLimit = Math.max(1_000, Number(limit) || DEFAULT_MANAGED_PROVIDER_DAILY_TOKEN_LIMIT);
  const remaining = resolvedProvider.managedProvider ? Math.max(0, safeLimit - providerTokensUsed) : null;
  const exhausted = resolvedProvider.managedProvider && remaining <= 0;
  const resolvedImageProvider = normalizeImageProviderState(imageProviderState
    || (providerState ? imageProviderStateFromModelProvider(resolvedProvider) : imageGenerationProviderState(root)));
  const imageUsage = imageGenerationUsageStatus(store, cleanUserId, { now, providerState: resolvedImageProvider });
  return {
    enabled: true,
    managedProvider: resolvedProvider.managedProvider,
    limited: resolvedProvider.managedProvider,
    quotaMode: managedProviderQuotaMode(),
    dailyTokenLimit: resolvedProvider.managedProvider ? safeLimit : null,
    dailyTokensUsed: providerTokensUsed,
    dailyTokensRemaining: remaining,
    usagePercent: resolvedProvider.managedProvider ? quotaPercent(providerTokensUsed, safeLimit) : null,
    exhausted,
    quotaDay: window.key,
    resetAt: window.resetAt,
    timezone: MANAGED_PROVIDER_QUOTA_TIMEZONE,
    providerScopeId: resolvedProvider.providerScopeId,
    todayAllProviderTokens: Math.max(0, Number(allProviderRow.raw_total_tokens) || 0),
    eventCount: Math.max(0, Number(row.event_count) || 0),
    lastTurnTokens: Math.max(0, Number(last?.raw_total_tokens) || 0),
    lastTurnInputTokens: Math.max(0, Number(last?.input_tokens) || 0),
    lastTurnOutputTokens: Math.max(0, Number(last?.output_tokens) || 0),
    lastTurnCachedInputTokens: Math.max(0, Number(last?.cached_input_tokens) || 0),
    lastTurnReasoningOutputTokens: Math.max(0, Number(last?.reasoning_output_tokens) || 0),
    usageSource: String(last?.usage_source || ''),
    ...imageUsage,
  };
}

export function imageGenerationUsageStatus(store, userId = '', {
  now = new Date(),
  limit = dailyImageGenerationLimit(),
  providerState = null,
} = {}) {
  const window = beijingQuotaDayWindow(now);
  const cleanUserId = String(userId || 'local_admin').trim() || 'local_admin';
  const resolvedProvider = normalizeImageProviderState(providerState);
  const usageSource = imageUsageSource(resolvedProvider);
  const safeLimit = Math.max(1, Number(limit) || DEFAULT_DAILY_IMAGE_GENERATION_LIMIT);
  const row = store?.db?.prepare?.(`SELECT
      COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) AS completed_count,
      COALESCE(SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END),0) AS reserved_count
    FROM managed_provider_usage_events
    WHERE user_id=? AND provider_scope_id=? AND quota_day=? AND usage_source=?`).get(
      cleanUserId, resolvedProvider.providerScopeId, window.key, usageSource,
    ) || {};
  const used = Math.max(0, Number(row.completed_count) || 0);
  const reserved = Math.max(0, Number(row.reserved_count) || 0);
  const admitted = used + reserved;
  const limited = resolvedProvider.managedProvider;
  return {
    imageGenerationManagedProvider: resolvedProvider.managedProvider,
    imageGenerationLimited: limited,
    imageProviderScopeId: resolvedProvider.providerScopeId,
    dailyImageLimit: limited ? safeLimit : null,
    dailyImagesUsed: used,
    dailyImagesReserved: reserved,
    dailyImagesRemaining: limited ? Math.max(0, safeLimit - admitted) : null,
    imageUsagePercent: limited ? quotaPercent(used, safeLimit) : null,
    imageGenerationExhausted: limited && admitted >= safeLimit,
    imageQuotaDay: window.key,
    imageQuotaResetAt: window.resetAt,
  };
}

export function reserveImageGeneration(store, {
  userId = '',
  accountWorkspaceId = '',
  executionId = '',
  sessionId = '',
  eventKey = '',
  agentId = '',
  model = 'gpt-image-2',
  privateAssistant = false,
  now = new Date(),
  limit = dailyImageGenerationLimit(),
  providerState = null,
} = {}) {
  if (!store?.db) throw new Error('Image generation quota storage is unavailable.');
  const cleanUserId = String(userId || 'local_admin').trim() || 'local_admin';
  const resolvedProvider = normalizeImageProviderState(providerState);
  const usageSource = imageUsageSource(resolvedProvider);
  const stableEventKey = String(eventKey || '').trim();
  if (!stableEventKey) throw new Error('Image generation quota event key is required.');
  const occurredAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const window = beijingQuotaDayWindow(now);
  const safeLimit = Math.max(1, Number(limit) || DEFAULT_DAILY_IMAGE_GENERATION_LIMIT);
  const ownsTransaction = !store.db.isTransaction;
  if (ownsTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    const existing = store.db.prepare('SELECT * FROM managed_provider_usage_events WHERE event_key=?').get(stableEventKey) || null;
    if (existing) {
      if (existing.user_id !== cleanUserId || existing.usage_source !== usageSource
        || existing.provider_scope_id !== resolvedProvider.providerScopeId) {
        throw new Error(`Image generation quota event key conflict: ${stableEventKey}`);
      }
      if (['reserved', 'completed'].includes(existing.status)) {
        if (ownsTransaction) store.db.exec('COMMIT');
        return { reserved: true, reused: true, event: existing, status: imageGenerationUsageStatus(store, cleanUserId, { now, limit: safeLimit, providerState: resolvedProvider }) };
      }
    }
    const admission = imageGenerationUsageStatus(store, cleanUserId, { now, limit: safeLimit, providerState: resolvedProvider });
    if (resolvedProvider.managedProvider && admission.imageGenerationExhausted) throw new ImageGenerationQuotaExceeded(admission);
    if (existing) {
      store.db.prepare(`UPDATE managed_provider_usage_events SET status='reserved',quota_day=?,occurred_at=? WHERE event_key=?`).run(
        window.key, occurredAt, stableEventKey,
      );
    } else {
      store.db.prepare(`INSERT INTO managed_provider_usage_events(
        id,event_key,user_id,account_workspace_id,provider_scope_id,device_id,execution_id,session_id,
        agent_id,model,usage_source,status,private_assistant,quota_day,occurred_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        newId('image_quota'), stableEventKey, cleanUserId, accountWorkspaceId || 'workspace_personal',
        resolvedProvider.providerScopeId, String(store.contextDeviceId?.() || 'local'), executionId, sessionId,
        agentId, model, usageSource, 'reserved', privateAssistant ? 1 : 0, window.key, occurredAt,
      );
    }
    if (ownsTransaction) store.db.exec('COMMIT');
    return { reserved: true, reused: Boolean(existing), eventKey: stableEventKey, status: imageGenerationUsageStatus(store, cleanUserId, { now, limit: safeLimit, providerState: resolvedProvider }) };
  } catch (error) {
    if (ownsTransaction && store.db.isTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
}

export function completeImageGeneration(store, eventKey = '', { userId = '', now = new Date(), limit, providerState = null } = {}) {
  const key = String(eventKey || '').trim();
  const resolvedProvider = imageProviderStateForEvent(store, key, providerState);
  const usageSource = imageUsageSource(resolvedProvider);
  if (!store?.db || !key) return { completed: false, status: imageGenerationUsageStatus(store, userId, { now, limit, providerState: resolvedProvider }) };
  const update = store.db.prepare(`UPDATE managed_provider_usage_events SET status='completed'
    WHERE event_key=? AND usage_source=? AND provider_scope_id=? AND status='reserved'`).run(
    key, usageSource, resolvedProvider.providerScopeId,
  );
  return {
    completed: Number(update.changes || 0) > 0,
    status: imageGenerationUsageStatus(store, userId, { now, limit, providerState: resolvedProvider }),
  };
}

export function failImageGeneration(store, eventKey = '', { userId = '', now = new Date(), limit, providerState = null } = {}) {
  const key = String(eventKey || '').trim();
  const resolvedProvider = imageProviderStateForEvent(store, key, providerState);
  const usageSource = imageUsageSource(resolvedProvider);
  if (!store?.db || !key) return { failed: false, status: imageGenerationUsageStatus(store, userId, { now, limit, providerState: resolvedProvider }) };
  const update = store.db.prepare(`UPDATE managed_provider_usage_events SET status='failed'
    WHERE event_key=? AND usage_source=? AND provider_scope_id=? AND status='reserved'`).run(
    key, usageSource, resolvedProvider.providerScopeId,
  );
  return {
    failed: Number(update.changes || 0) > 0,
    status: imageGenerationUsageStatus(store, userId, { now, limit, providerState: resolvedProvider }),
  };
}

export function assertManagedProviderQuotaAvailable(store, userId = '', options = {}) {
  const status = managedProviderUsageStatus(store, userId, options);
  if (status.managedProvider && status.exhausted && status.quotaMode === 'enforce') {
    throw new ManagedProviderQuotaExceeded(status);
  }
  return status;
}

export function recordModelTokenUsage(store, {
  root = '',
  userId = '',
  accountWorkspaceId = '',
  executionId = '',
  sessionId = '',
  threadId = '',
  turnId = '',
  eventKey = '',
  eventIndex = 0,
  agentId = '',
  agentInstanceId = '',
  model = '',
  reasoningEffort = '',
  usage = null,
  usageKind = 'auto',
  cursorUsage = null,
  status = 'completed',
  privateAssistant = false,
  resumedExistingThread = false,
  occurredAt = new Date().toISOString(),
  providerState = null,
  usageSource = '',
} = {}) {
  if (!store?.db) return { inserted: false, status: null, event: null };
  const normalized = codexTokenUsage(usage || {});
  if (!normalized) return { inserted: false, status: managedProviderUsageStatus(store, userId, { root, providerState }), event: null };
  const normalizedCursorUsage = codexTokenUsage(cursorUsage || {});
  const resolvedProvider = providerState || modelUsageProviderState(root);
  const cleanUserId = String(userId || 'local_admin').trim() || 'local_admin';
  const cleanThreadId = String(threadId || '').trim();
  const cleanTurnId = String(turnId || '').trim();
  const deviceId = String(store.contextDeviceId?.() || 'local');
  const normalizedUsageKind = String(usageKind || 'auto').trim().toLowerCase();
  const resolvedUsageKind = normalizedUsageKind === 'turn'
    ? 'turn'
    : normalizedUsageKind === 'thread_cumulative'
      ? 'thread_cumulative'
      : normalized.last || resumedExistingThread
        ? 'thread_cumulative'
        : 'turn';
  const cumulativeUsage = normalizedCursorUsage || (resolvedUsageKind === 'thread_cumulative' ? normalized : null);
  const cumulativeTotal = Math.max(0, Number(cumulativeUsage?.totalTokens) || 0);
  let turnUsage = resolvedUsageKind === 'turn' ? normalized.last || normalized : null;
  let source = String(usageSource || '').trim();

  const cursor = cleanThreadId ? store.db.prepare(`SELECT * FROM managed_provider_thread_cursors
    WHERE user_id=? AND provider_scope_id=? AND device_id=? AND thread_id=?`).get(
      cleanUserId, resolvedProvider.providerScopeId, deviceId, cleanThreadId,
    ) : null;
  if (resolvedUsageKind === 'turn') {
    source ||= normalizedCursorUsage ? 'provider_response' : 'provider_turn';
  } else if (!turnUsage) {
    if (cursor && cumulativeTotal >= Number(cursor.last_total_tokens || 0)) {
      const delta = Math.max(0, cumulativeTotal - Number(cursor.last_total_tokens || 0));
      turnUsage = proportionalUsage(cumulativeUsage, delta);
      source ||= 'thread_total_delta';
    } else if (!resumedExistingThread) {
      turnUsage = cumulativeUsage || normalized;
      source ||= 'provider_thread_total';
    } else if (normalized.last) {
      turnUsage = normalized.last;
      source ||= 'provider_last_baseline';
    } else {
      turnUsage = proportionalUsage(normalized, 0);
      source ||= 'thread_total_baseline';
    }
  }

  const rawTotalTokens = Math.max(0, Number(turnUsage.totalTokens) || 0);
  const window = beijingQuotaDayWindow(occurredAt);
  const stableEventKey = String(eventKey || '').trim() || sha256Text([
    'model-token-usage-v1', cleanUserId, resolvedProvider.providerScopeId,
    executionId || '', cleanThreadId, cleanTurnId, eventIndex,
  ].join('\n'));
  const id = newId('model_usage');
  const event = {
    id,
    eventKey: stableEventKey,
    rawTotalTokens,
    usageSource: source,
    managedProvider: resolvedProvider.managedProvider,
  };
  const ownsTransaction = !store.db.isTransaction;
  if (ownsTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    const insert = store.db.prepare(`INSERT INTO managed_provider_usage_events(
      id,event_key,user_id,account_workspace_id,provider_scope_id,device_id,execution_id,session_id,
      thread_id,turn_id,agent_id,agent_instance_id,model,reasoning_effort,input_tokens,output_tokens,
      cached_input_tokens,cache_write_input_tokens,reasoning_output_tokens,raw_total_tokens,charged_tokens,
      usage_source,status,private_assistant,quota_day,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`).run(
      id, stableEventKey, cleanUserId, accountWorkspaceId || 'workspace_personal', resolvedProvider.providerScopeId,
      deviceId, executionId, sessionId, cleanThreadId, cleanTurnId, agentId, agentInstanceId, model, reasoningEffort,
      tokenNumber(turnUsage.inputTokens), tokenNumber(turnUsage.outputTokens), tokenNumber(turnUsage.cachedInputTokens),
      tokenNumber(turnUsage.cacheWriteInputTokens), tokenNumber(turnUsage.reasoningOutputTokens), rawTotalTokens,
      resolvedProvider.managedProvider ? rawTotalTokens : 0, source, status, privateAssistant ? 1 : 0,
      window.key, occurredAt,
    );
    if (cleanThreadId && cumulativeTotal > 0) {
      store.db.prepare(`INSERT INTO managed_provider_thread_cursors(
        user_id,provider_scope_id,device_id,thread_id,last_total_tokens,last_turn_id,updated_at
      ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,provider_scope_id,device_id,thread_id) DO UPDATE SET
        last_total_tokens=CASE WHEN excluded.last_total_tokens>=managed_provider_thread_cursors.last_total_tokens
          THEN excluded.last_total_tokens ELSE managed_provider_thread_cursors.last_total_tokens END,
        last_turn_id=CASE WHEN excluded.last_total_tokens>=managed_provider_thread_cursors.last_total_tokens
          THEN excluded.last_turn_id ELSE managed_provider_thread_cursors.last_turn_id END,
        updated_at=excluded.updated_at`).run(
        cleanUserId, resolvedProvider.providerScopeId, deviceId, cleanThreadId, cumulativeTotal, cleanTurnId, occurredAt,
      );
    }
    const inserted = Number(insert.changes || 0) > 0;
    if (ownsTransaction) store.db.exec('COMMIT');
    return {
      inserted,
      event: inserted ? event : null,
      status: managedProviderUsageStatus(store, cleanUserId, { root, providerState: resolvedProvider }),
    };
  } catch (error) {
    if (ownsTransaction && store.db.isTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
}

export function privateAssistantTextUsageSince(store, userId = '', startAt = '') {
  const row = store?.db?.prepare?.(`SELECT COALESCE(SUM(raw_total_tokens),0) AS total_tokens
    FROM managed_provider_usage_events WHERE user_id=? AND private_assistant=1 AND occurred_at>=?
      AND usage_source NOT LIKE 'image_api_%'`).get(
      String(userId || 'local_admin'), String(startAt || ''),
    ) || {};
  return Math.max(0, Number(row.total_tokens) || 0);
}

function tokenNumber(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function imageProviderStateFromModelProvider(provider = {}) {
  if (provider.managedProvider) return normalizeImageProviderState({ managedProvider: true });
  return normalizeImageProviderState({
    managedProvider: false,
    providerScopeId: customImageProviderScopeId(
      provider.config?.providerName || provider.providerScopeId || 'custom',
      provider.config?.baseUrl || '',
    ),
  });
}

function normalizeImageProviderState(provider = null) {
  const managedProvider = provider?.managedProvider !== false;
  return {
    ...(provider || {}),
    managedProvider,
    limited: managedProvider,
    providerScopeId: String(provider?.providerScopeId || '').trim()
      || (managedProvider
        ? MANAGED_IMAGE_PROVIDER_SCOPE_ID
        : customImageProviderScopeId('custom', '')),
  };
}

function imageProviderStateForEvent(store, eventKey = '', providerState = null) {
  if (providerState) return normalizeImageProviderState(providerState);
  const event = store?.db && eventKey
    ? store.db.prepare('SELECT provider_scope_id,usage_source FROM managed_provider_usage_events WHERE event_key=?').get(eventKey)
    : null;
  if (!event) return normalizeImageProviderState(null);
  return normalizeImageProviderState({
    managedProvider: event.usage_source !== CUSTOM_IMAGE_USAGE_SOURCE,
    providerScopeId: event.provider_scope_id,
  });
}

function imageUsageSource(provider = {}) {
  return provider.managedProvider ? IMAGE_QUOTA_USAGE_SOURCE : CUSTOM_IMAGE_USAGE_SOURCE;
}

function quotaPercent(used, limit) {
  return Number(Math.min(100, (Math.max(0, Number(used) || 0) / Math.max(1, Number(limit) || 1)) * 100).toFixed(2));
}

function proportionalUsage(usage = {}, totalTokens = 0) {
  const total = tokenNumber(totalTokens);
  const originalTotal = Math.max(1, tokenNumber(usage.totalTokens));
  const ratio = total / originalTotal;
  const inputTokens = Math.min(total, Math.round(tokenNumber(usage.inputTokens) * ratio));
  const outputTokens = Math.max(0, total - inputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Math.min(inputTokens, Math.round(tokenNumber(usage.cachedInputTokens) * ratio)),
    cacheWriteInputTokens: Math.min(inputTokens, Math.round(tokenNumber(usage.cacheWriteInputTokens) * ratio)),
    reasoningOutputTokens: Math.min(outputTokens, Math.round(tokenNumber(usage.reasoningOutputTokens) * ratio)),
    totalTokens: total,
  };
}
