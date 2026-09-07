import assert from 'node:assert/strict';

import {
  DEFAULT_PRIVATE_ASSISTANT_WEEKLY_TOKEN_LIMIT,
  privateAssistantPermissionMode,
  privateAssistantUsageStatus,
  recordPrivateAssistantUsage,
  resolvePrivateAssistantTurnUsage,
} from '../src/main/privateAssistant.js';

const settings = new Map();
const store = {
  settingGet(key, fallback = '') { return settings.has(key) ? settings.get(key) : fallback; },
  settingSet(key, value) { settings.set(key, String(value)); },
};
const now = new Date('2026-07-26T12:00:00+08:00');

assert.equal(DEFAULT_PRIVATE_ASSISTANT_WEEKLY_TOKEN_LIMIT, 20_000_000);
assert.equal(privateAssistantPermissionMode('request-approval'), 'request-approval');
assert.equal(privateAssistantPermissionMode('task-workspace'), 'task-workspace');
assert.equal(privateAssistantPermissionMode('full-access'), 'request-approval');
assert.equal(privateAssistantPermissionMode('auto-approve'), 'request-approval');
assert.equal(privateAssistantUsageStatus(store, 'quota-user', { now }).weeklyTokensUsed, 0);

let status = recordPrivateAssistantUsage(store, 'quota-user', {
  inputTokens: 16_000,
  outputTokens: 4_000,
  totalTokens: 20_000,
  source: 'provider',
}, { now });
assert.equal(status.weeklyTextTokensUsed, 20_000);
assert.equal(status.weeklyImageEquivalentTokensUsed, 0);
assert.equal(status.weeklyTokensUsed, 20_000);

const splitTurn = resolvePrivateAssistantTurnUsage({ usage: { tokenUsage: {
  total: { inputTokens: 60_470, outputTokens: 100, totalTokens: 60_570 },
  last: { inputTokens: 17_463, outputTokens: 20, totalTokens: 17_483 },
} } }, '', '');
assert.equal(splitTurn.totalTokens, 17_483);
assert.equal(splitTurn.source, 'provider');

const cumulativeOnlyTurn = resolvePrivateAssistantTurnUsage({ usage: { tokenUsage: {
  total: { inputTokens: 60_470, outputTokens: 100, totalTokens: 60_570 },
} } }, '四个中文字符', '回答');
assert.equal(cumulativeOnlyTurn.totalTokens, 8);
assert.equal(cumulativeOnlyTurn.source, 'estimated');

const legacySettings = new Map();
const legacyStore = {
  settingGet(key, fallback = '') { return legacySettings.has(key) ? legacySettings.get(key) : fallback; },
  settingSet(key, value) { legacySettings.set(key, String(value)); },
};
legacyStore.settingSet('private_assistant:usage:legacy-user:2026-07-20', '50000');
legacyStore.settingSet('private_assistant:usage:legacy-user:2026-07-20:image_equivalent', '10000');
const migrated = privateAssistantUsageStatus(legacyStore, 'legacy-user', { now });
assert.equal(migrated.weeklyTextTokensUsed, 40_000);
assert.equal(migrated.weeklyImageEquivalentTokensUsed, 10_000, 'legacy image accounting remains available for audit');
assert.equal(migrated.weeklyTokensUsed, 40_000, 'legacy image equivalents must not consume the weekly text allowance');

console.log('private assistant unified quota smoke passed');
