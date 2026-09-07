import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createPickerMentionEntity, mentionPrincipalId, normalizeMentionEntities } from '../src/shared/contracts/mentions.js';
import { normalizeUBuddyDispatchV3 } from '../src/shared/contracts/uBuddyDispatch.js';

const pluginMention = createPickerMentionEntity({
  principalType: 'plugin',
  pluginId: 'zotero@openai-api-curated',
  displayText: '@Zotero',
  mentionId: 'mention-zotero',
});

assert.equal(pluginMention.principalType, 'plugin');
assert.equal(pluginMention.pluginId, 'zotero@openai-api-curated');
assert.equal(mentionPrincipalId(pluginMention), 'zotero@openai-api-curated');
assert.equal(normalizeMentionEntities([pluginMention], { content: '@Zotero 查找论文' }).length, 1);
assert.equal(normalizeMentionEntities([pluginMention], { content: '查找论文' }).length, 0);
assert.equal(normalizeMentionEntities([pluginMention], { content: '@Zotero', allowedUserIds: [] }).length, 1);

const dispatch = normalizeUBuddyDispatchV3({
  version: 3,
  id: 'plugin-dispatch',
  title: 'Zotero 查询',
  dispatchType: 'local_agent',
  intent: 'single_agent_task',
  objective: '查询文献',
  mentions: [pluginMention],
});
assert.equal(dispatch.mentions[0]?.principalType, 'plugin');
assert.equal(dispatch.mentions[0]?.pluginId, 'zotero@openai-api-curated');
assert.equal(dispatch.participants.length, 0);

const runtimeSource = fs.readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
const messageSendSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
assert.match(runtimeSource, /Never use Shell commands or MCP configuration as a fallback for a Codex plugin request/);
assert.match(runtimeSource, /installing or configuring an MCP server must never be reported as installing a Plugin/);
assert.match(runtimeSource, /normalizedPluginMentions/);
assert.match(runtimeSource, /codex_plugin_mention_unavailable/);
assert.match(runtimeSource, /withNativePluginMentionContext/);
assert.match(messageSendSource, /mentions: outgoingMentions/);
assert.match(messageSendSource, /\['plugin', 'skill'\]\.includes\(mention\.principalType\)/);

console.log('native plugin mention smoke passed');
