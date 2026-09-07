import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { state as rendererState } from '../src/renderer/app/state.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';

import {
  DEFAULT_MANAGED_PROVIDER_DAILY_TOKEN_LIMIT,
  DEFAULT_DAILY_IMAGE_GENERATION_LIMIT,
  ImageGenerationQuotaExceeded,
  ManagedProviderQuotaExceeded,
  assertManagedProviderQuotaAvailable,
  beijingQuotaDayWindow,
  managedProviderUsageStatus,
  imageGenerationUsageStatus,
  reserveImageGeneration,
  completeImageGeneration,
  failImageGeneration,
  recordModelTokenUsage,
} from '../src/main/managedProviderUsage.js';
import {
  privateAssistantUsageStatus,
  privateAssistantWeekWindow,
} from '../src/main/privateAssistant.js';

const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE managed_provider_usage_events (
  id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL DEFAULT '',
  account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',provider_scope_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'local',execution_id TEXT NOT NULL DEFAULT '',session_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',turn_id TEXT NOT NULL DEFAULT '',agent_id TEXT NOT NULL DEFAULT '',
  agent_instance_id TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  raw_total_tokens INTEGER NOT NULL DEFAULT 0,charged_tokens INTEGER NOT NULL DEFAULT 0,usage_source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',private_assistant INTEGER NOT NULL DEFAULT 0,quota_day TEXT NOT NULL,
  occurred_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE managed_provider_thread_cursors (
  user_id TEXT NOT NULL,provider_scope_id TEXT NOT NULL,device_id TEXT NOT NULL DEFAULT 'local',thread_id TEXT NOT NULL,
  last_total_tokens INTEGER NOT NULL DEFAULT 0,last_turn_id TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(user_id,provider_scope_id,device_id,thread_id)
)`);

const settings = new Map();
const store = {
  db,
  contextDeviceId: () => 'device-test',
  settingGet: (key, fallback = '') => settings.has(key) ? settings.get(key) : fallback,
  settingSet: (key, value) => settings.set(key, String(value)),
};
const managed = { managedProvider: true, providerScopeId: 'managed-test', config: {} };
const custom = { managedProvider: false, providerScopeId: 'custom-test', config: {} };
const customB = { managedProvider: false, providerScopeId: 'custom-test-b', config: {} };
const customImage = { managedProvider: false, providerScopeId: 'custom-image-test', config: {} };
const now = new Date();

assert.equal(DEFAULT_MANAGED_PROVIDER_DAILY_TOKEN_LIMIT, 20_000_000);
assert.equal(DEFAULT_DAILY_IMAGE_GENERATION_LIMIT, 5);

assert.equal(beijingQuotaDayWindow('2026-08-08T15:59:59.999Z').key, '2026-08-08');
assert.equal(beijingQuotaDayWindow('2026-08-08T16:00:00.000Z').key, '2026-08-09');

const first = recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-1', threadId: 'thread-a', turnId: 'turn-1', eventKey: 'event-1',
  usage: {
    inputTokens: 70, outputTokens: 30, cachedInputTokens: 40, reasoningOutputTokens: 10, totalTokens: 100,
  },
  usageKind: 'turn',
  cursorUsage: { total: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 }, last: {
    inputTokens: 70, outputTokens: 30, cachedInputTokens: 40, reasoningOutputTokens: 10, totalTokens: 100,
  } },
  model: 'gpt-test', reasoningEffort: 'high',
  providerState: managed, occurredAt: now.toISOString(), privateAssistant: true,
});
assert.equal(first.inserted, true);
assert.equal(first.status.dailyTokensUsed, 100, 'cached and reasoning sub-tokens must not be added again');
const firstRow = db.prepare('SELECT * FROM managed_provider_usage_events WHERE event_key=?').get('event-1');
assert.equal(firstRow.model, 'gpt-test');
assert.equal(firstRow.reasoning_effort, 'high');
assert.equal(firstRow.cached_input_tokens, 40);
assert.equal(firstRow.reasoning_output_tokens, 10);
assert.equal(firstRow.raw_total_tokens, 100);

const duplicate = recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-1', threadId: 'thread-a', turnId: 'turn-1', eventKey: 'event-1',
  usage: { totalTokens: 100 }, providerState: managed, occurredAt: now.toISOString(),
});
assert.equal(duplicate.inserted, false);
assert.equal(duplicate.status.dailyTokensUsed, 100, 'the same execution/turn event must settle once');

recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-1', threadId: 'thread-a', turnId: 'turn-2', eventKey: 'event-2',
  usage: { total: { inputTokens: 900, outputTokens: 260, totalTokens: 1160 }, last: {
    inputTokens: 30, outputTokens: 20, totalTokens: 50,
  } },
  usageKind: 'thread_cumulative',
  providerState: managed, occurredAt: now.toISOString(), resumedExistingThread: true,
});
assert.equal(managedProviderUsageStatus(store, 'user-a', { providerState: managed, now }).dailyTokensUsed, 260,
  'the thread high-water delta must include every model response in the turn instead of only tokenUsage.last');

recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-old', threadId: 'old-thread', turnId: 'old-turn', eventKey: 'event-old',
  usage: { inputTokens: 9000, outputTokens: 999, totalTokens: 9999 },
  usageKind: 'thread_cumulative',
  providerState: managed, occurredAt: now.toISOString(), resumedExistingThread: true,
});
assert.equal(managedProviderUsageStatus(store, 'user-a', { providerState: managed, now }).dailyTokensUsed, 260,
  'an old resumed thread without a cursor must establish a baseline instead of charging its full history');

const unusedAccountStatus = managedProviderUsageStatus(store, 'user-b', { providerState: managed, now });
assert.equal(unusedAccountStatus.dailyTokensUsed, 0, 'an unused account must start at zero');
assert.equal(unusedAccountStatus.dailyTokensRemaining, 20_000_000, 'an unused account must retain its full allowance');
assert.equal(unusedAccountStatus.usagePercent, 0, 'an unused account must expose a renderable zero-percent status');

recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-custom', eventKey: 'event-custom',
  usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
  providerState: custom, occurredAt: now.toISOString(),
});
const customStatus = managedProviderUsageStatus(store, 'user-a', { providerState: custom, now });
assert.equal(customStatus.managedProvider, false);
assert.equal(customStatus.dailyTokenLimit, null);
assert.equal(customStatus.dailyTokensUsed, 200, 'custom provider usage must include only the active provider scope');
assert.equal(customStatus.todayAllProviderTokens, 460, 'all-provider usage remains available as a diagnostic total');
assert.equal(customStatus.lastTurnTokens, 200, 'latest-turn usage must come from the active provider scope');
assert.equal(customStatus.imageGenerationLimited, false, 'a custom model provider must expose unlimited custom image status');

recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-custom-b', eventKey: 'event-custom-b',
  usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
  providerState: customB, occurredAt: now.toISOString(),
});
assert.equal(managedProviderUsageStatus(store, 'user-a', { providerState: customB, now }).dailyTokensUsed, 50,
  'different custom providers must retain separate daily usage buckets');
assert.equal(managedProviderUsageStatus(store, 'user-a', { providerState: custom, now }).dailyTokensUsed, 200,
  'switching providers must not mutate the previous provider bucket');

recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'exec-limit', eventKey: 'event-limit',
  usage: { inputTokens: 600, outputTokens: 140, totalTokens: 740 },
  providerState: managed, occurredAt: now.toISOString(),
});
assert.throws(() => assertManagedProviderQuotaAvailable(store, 'user-a', {
  providerState: managed, now, limit: 1000,
}), ManagedProviderQuotaExceeded);
assert.equal(managedProviderUsageStatus(store, 'user-b', { providerState: managed, now }).dailyTokensUsed, 0,
  'another account must not inherit the active account usage');

const privateWindow = privateAssistantWeekWindow(now);
settings.set(`private_assistant:usage:user-a:${privateWindow.key}:text`, '50');
let privateStatus = privateAssistantUsageStatus(store, 'user-a', { now, limit: 1000 });
assert.equal(privateStatus.weeklyTextTokensUsed, 150, 'private assistant weekly text usage must reuse the unified turn event');
recordModelTokenUsage(store, {
  userId: 'user-a', executionId: 'image-exec', eventKey: 'image-api:image-exec',
  usage: { inputTokens: 20, outputTokens: 180, totalTokens: 200 }, usageKind: 'turn',
  providerState: managed, occurredAt: now.toISOString(), privateAssistant: true,
  usageSource: 'image_api_provider',
});
privateStatus = privateAssistantUsageStatus(store, 'user-a', { now, limit: 1000 });
assert.equal(privateStatus.weeklyTextTokensUsed, 150, 'image ledger events must not be counted again as private text');
assert.equal(managedProviderUsageStatus(store, 'user-a', { providerState: managed, now }).dailyTokensUsed, 1000,
  'legacy image token events must remain history without consuming the text-token allowance');

const imageNow = new Date('2026-08-08T15:59:59.999Z');
for (let index = 1; index <= 5; index += 1) {
  const eventKey = `image-slot-${index}`;
  const reservation = reserveImageGeneration(store, {
    userId: 'image-user', eventKey, executionId: `image-exec-${index}`, now: imageNow,
  });
  assert.equal(reservation.reserved, true);
  if (index < 5) completeImageGeneration(store, eventKey, { userId: 'image-user', now: imageNow });
}
let imageStatus = imageGenerationUsageStatus(store, 'image-user', { now: imageNow });
assert.equal(imageStatus.dailyImagesUsed, 4);
assert.equal(imageStatus.dailyImagesReserved, 1);
assert.equal(imageStatus.imageGenerationExhausted, true, 'active reservations must participate in admission');
assert.throws(() => reserveImageGeneration(store, {
  userId: 'image-user', eventKey: 'image-slot-6', executionId: 'image-exec-6', now: imageNow,
}), ImageGenerationQuotaExceeded, 'the sixth concurrent admission must be rejected');

failImageGeneration(store, 'image-slot-5', { userId: 'image-user', now: imageNow });
reserveImageGeneration(store, {
  userId: 'image-user', eventKey: 'image-slot-replacement', executionId: 'image-exec-replacement', now: imageNow,
});
completeImageGeneration(store, 'image-slot-replacement', { userId: 'image-user', now: imageNow });
imageStatus = imageGenerationUsageStatus(store, 'image-user', { now: imageNow });
assert.equal(imageStatus.dailyImagesUsed, 5, 'a failed provider request must release its reserved slot');

const duplicateReservation = reserveImageGeneration(store, {
  userId: 'image-user', eventKey: 'image-slot-replacement', executionId: 'image-exec-replacement', now: imageNow,
});
assert.equal(duplicateReservation.reused, true);
assert.equal(imageGenerationUsageStatus(store, 'image-user', { now: imageNow }).dailyImagesUsed, 5,
  'retrying the same stable event must not double count');
assert.equal(imageGenerationUsageStatus(store, 'image-user', { now: '2026-08-08T16:00:00.000Z' }).dailyImagesUsed, 0,
  'the image allowance must reset at Beijing midnight');
assert.equal(imageGenerationUsageStatus(store, 'another-image-user', { now: imageNow }).dailyImagesUsed, 0,
  'the image allowance must be isolated per user');

for (let index = 1; index <= 6; index += 1) {
  const eventKey = `custom-image-slot-${index}`;
  reserveImageGeneration(store, {
    userId: 'image-user', eventKey, executionId: `custom-image-exec-${index}`, now: imageNow,
    providerState: customImage,
  });
  completeImageGeneration(store, eventKey, { userId: 'image-user', now: imageNow, providerState: customImage });
}
const customImageStatus = imageGenerationUsageStatus(store, 'image-user', { now: imageNow, providerState: customImage });
assert.equal(customImageStatus.dailyImagesUsed, 6);
assert.equal(customImageStatus.dailyImageLimit, null);
assert.equal(customImageStatus.dailyImagesRemaining, null);
assert.equal(customImageStatus.imageGenerationExhausted, false,
  'custom image providers must remain observable without enforcing the Janus daily image limit');
assert.equal(imageGenerationUsageStatus(store, 'image-user', { now: imageNow }).dailyImagesUsed, 5,
  'custom image usage must not contaminate the managed image allowance');
assert.equal(db.prepare('SELECT usage_source FROM managed_provider_usage_events WHERE event_key=?').get('custom-image-slot-1').usage_source,
  'image_usage_unlimited_v2', 'custom image events need a rollback-safe usage source');

Object.assign(rendererState, {
  currentUser: { id: 'usage-renderer-admin', role: 'admin', displayName: 'Usage Admin' },
  currentSettingsSection: 'account',
  languageMode: 'zh-CN',
  codexConfig: { configurationMode: 'embedded-with-user-override', credentialSource: 'stored' },
  managedProviderUsage: {
    managedProvider: true,
    dailyTokensUsed: 0,
    dailyImagesUsed: 0,
    dailyImageLimit: 5,
    dailyImagesRemaining: 5,
    imageGenerationLimited: true,
  },
});
const managedUsageMarkup = renderSettings();
assert.match(managedUsageMarkup, /0 \/ 20,000,000 tokens/,
  'the renderer fallback must match the 20M managed Provider allowance');

Object.assign(rendererState, {
  managedProviderUsage: { ...customStatus, ...customImageStatus },
});
const customUsageMarkup = renderSettings();
assert.match(customUsageMarkup, /今日模型用量/);
assert.match(customUsageMarkup, /200 tokens/);
assert.match(customUsageMarkup, /今日图片生成用量/);
assert.match(customUsageMarkup, /6 张 · 不限额/);
assert.doesNotMatch(customUsageMarkup, /今日图片生成额度/);

db.close();
console.log('Managed provider usage smoke passed.');
