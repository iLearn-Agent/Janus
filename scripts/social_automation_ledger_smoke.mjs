import assert from 'node:assert/strict';

import { createSocialAutomationLedger } from '../src/main/modules/collaboration/application/socialAutomationLedger.js';

const settings = new Map();
const ledger = createSocialAutomationLedger({
  store: {
    settingGet(key, fallback = '') { return settings.has(key) ? settings.get(key) : fallback; },
    settingSet(key, value) { settings.set(key, String(value)); },
  },
});
const scope = {
  userId: 'user_a',
  workspaceId: 'workspace_personal',
  automationType: 'chat_group_ubuddy_reply',
  scopeId: 'group_a',
};
const oldHistory = { id: 'message_old', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' };

assert.equal(ledger.establishScopeBaseline(scope, [oldHistory]), true);
assert.equal(ledger.hasProcessed({ ...scope, sourceMessageId: oldHistory.id }), true, 'initial history must be baselined without automation');

const editedOldHistory = { ...oldHistory, updatedAt: '2026-08-06T12:00:00.000Z' };
assert.equal(ledger.hasProcessed({ ...scope, sourceMessageId: editedOldHistory.id }), true, 'read/edit timestamps must not retrigger a processed message id');

const delayedNewMessage = { id: 'message_delayed_new', createdAt: '2026-08-05T00:00:00.000Z' };
assert.equal(ledger.hasProcessed({ ...scope, sourceMessageId: delayedNewMessage.id }), false, 'a genuinely new delayed message id must remain eligible');
ledger.markProcessed({ ...scope, sourceMessageId: delayedNewMessage.id });
assert.equal(ledger.hasProcessed({ ...scope, sourceMessageId: delayedNewMessage.id }), true, 'a new message must process only once');

assert.equal(
  ledger.hasProcessed({ ...scope, workspaceId: 'workspace_org_other', sourceMessageId: delayedNewMessage.id }),
  false,
  'automation identity must remain Workspace-scoped',
);

process.stdout.write('Social automation ledger smoke passed.\n');
