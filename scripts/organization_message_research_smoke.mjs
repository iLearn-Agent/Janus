import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { EncryptedOrganizationResearchCache, OrganizationResearchService } from '../src/main/modules/organizationResearch/index.js';
import { validateOrganizationResearchAnswer } from '../src/shared/contracts/organizationMessageResearch.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-organization-research-'));
let currentTime = new Date('2026-08-11T08:00:00.000Z');
const codec = {
  status: () => ({ available: true, secure: true, backend: 'test-keyring' }),
  encrypt: (value) => Buffer.from(`wrapped:${value}`).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString().slice('wrapped:'.length),
};
const db = openDatabase(root, { appVersion: '1.0.0' });
const cache = new EncryptedOrganizationResearchCache({ db, root, credentialCodec: codec, now: () => new Date(currentTime) });

try {
  const beforeInventory = coreInventory(db);
  cache.initialize({ organizationId: 'org_alpha', userId: 'user_a', deviceId: 'device_a' });
  cache.setLease('org_alpha', {
    id: 'lease_a', token: 'lease-secret', expiresAt: '2026-08-12T08:00:00.000Z',
  });

  const changes = Array.from({ length: 30 }, (_, index) => ({
    sequenceId: index + 1,
    operation: 'upsert',
    document: {
      organizationId: 'org_alpha', sourceKind: index % 2 ? 'direct_message' : 'chat_group',
      sourceMessageId: `message_${index}`, conversationId: `conversation_${index % 10}`,
      conversationTitle: `项目群 ${index % 10}`, senderUserId: `user_${index % 4}`,
      senderDisplayName: index % 2 ? '张三' : '李四', body: `预算审批 中文调查关键字 ${index}`,
      attachmentNames: index === 3 ? ['预算明细.xlsx'] : [],
      createdAt: new Date(Date.UTC(2026, 7, 11, 8, 0, index)).toISOString(), revision: 1,
    },
  }));
  const applied = cache.applyChanges('org_alpha', changes, { cursor: 30 });
  assert.equal(applied.documentCount, 30);
  cache.applyChanges('org_alpha', changes, { cursor: 30 });
  assert.equal(cache.readDocuments('org_alpha').length, 30, 'duplicate delivery must be idempotent');

  const state = cache.state('org_alpha');
  const shardText = fs.readFileSync(state.encrypted_shard_path, 'utf8');
  assert.doesNotMatch(shardText, /预算审批|张三|预算明细/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'data', 'janus.db'), 'latin1'), /预算审批|张三|预算明细/);
  const sqliteColumns = db.prepare('PRAGMA table_info(organization_research_cache_state)').all().map((row) => row.name);
  assert.equal(sqliteColumns.includes('body'), false);

  const search = cache.search('org_alpha', { query: '预算审批', mode: 'offline', userId: 'user_a' });
  assert.equal(search.hits.length, 24);
  assert.ok(new Set(search.hits.map((item) => item.conversationId)).size <= 8);
  assert.ok(search.hits.every((item) => item.citation.id.startsWith('orgmsg:org_alpha:')));
  cache.completeAudit(search.auditId, { resultCount: search.hits.length, citationIds: search.hits.map((item) => item.citation.id) });
  const audit = db.prepare('SELECT encrypted_payload FROM organization_research_audit_outbox WHERE id=?').get(search.auditId);
  assert.doesNotMatch(audit.encrypted_payload, /预算审批|orgmsg:org_alpha/);

  const attachmentSearch = cache.search('org_alpha', { query: '预算明细.xlsx', filters: { personIds: ['user_3'] } });
  assert.equal(attachmentSearch.hits.length, 1);
  const personNameSearch = cache.search('org_alpha', { query: '预算审批', filters: { personIds: ['张三'] } });
  assert.ok(personNameSearch.hits.length > 0);
  assert.ok(personNameSearch.hits.every((item) => item.senderDisplayName === '张三'));
  const context = cache.readContext('org_alpha', { sourceKind: 'direct_message', messageId: 'message_3' });
  assert.ok(context.messages.length <= 21);
  assert.equal(context.bounded, true);

  const citationIds = search.hits.slice(0, 2).map((item) => item.citation.id);
  assert.throws(() => validateOrganizationResearchAnswer({ answer: 'bad', citationIds: ['orgmsg:other'] }, citationIds),
    /invalid citations/);
  assert.equal(validateOrganizationResearchAnswer({ answer: 'ok', citationIds }, citationIds).citationIds.length, 2);

  const uploadedAudits = [];
  let researchExecutionCount = 0;
  const researchService = new OrganizationResearchService({
    cache,
    socialRelay: {
      uploadOrganizationResearchAudit: async (_organizationId, payload) => { uploadedAudits.push(payload); return { ok: true }; },
    },
    execute: async ({ prompt, executionContext, role, permissionMode, dynamicTools, onDynamicToolCall }) => {
      researchExecutionCount += 1;
      assert.equal(executionContext, null);
      assert.equal(role, 'ubuddy-organization-research');
      assert.equal(permissionMode, 'draft-stream');
      assert.match(prompt, /untrusted data/i);
      if (researchExecutionCount > 1) assert.match(prompt, /Previous eligible research context/);
      assert.deepEqual(dynamicTools[0].tools.map((tool) => tool.name), [
        'search_organization_messages', 'read_organization_message_context',
      ]);
      const searchToolResult = await onDynamicToolCall({
        namespace: 'janus', tool: 'search_organization_messages', arguments: { query: '预算审批' },
      });
      const toolPayload = JSON.parse(searchToolResult.contentItems[0].text);
      const hit = toolPayload.hits[0];
      const unauthorizedContext = await onDynamicToolCall({
        namespace: 'janus', tool: 'read_organization_message_context',
        arguments: { sourceKind: 'direct_message', messageId: 'not-a-hit' },
      });
      assert.equal(unauthorizedContext.success, false);
      const authorizedContext = await onDynamicToolCall({
        namespace: 'janus', tool: 'read_organization_message_context',
        arguments: { sourceKind: hit.sourceKind, messageId: hit.sourceMessageId },
      });
      assert.equal(authorizedContext.success, true);
      const allowedCitation = hit.citation.id;
      return JSON.stringify({ answer: '综合结果仅保存在加密上下文', citationIds: [allowedCitation], insufficientEvidence: false });
    },
  });
  const researchResult = await researchService.research({
    organizationId: 'org_alpha', userId: 'user_a', deviceId: 'device_a', prompt: '预算审批', online: false,
    decision: { requiresOrganizationResearch: true, continuesResearchTopic: false, filters: {} },
  });
  assert.equal(researchResult.persistentThreadUsed, false);
  assert.equal(researchResult.memoryWritten, false);
  assert.match(researchResult.placeholder, /^\[organization-research-result:/);
  assert.ok(uploadedAudits.length >= 1);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'data', 'janus.db'), 'latin1'), /综合结果仅保存在加密上下文/);
  const persistedResearch = db.prepare('SELECT citation_ids_json FROM organization_research_contexts WHERE id=?').get(researchResult.resultId);
  assert.equal(persistedResearch.citation_ids_json, '[]', 'stable source references must not be stored as plaintext SQLite metadata');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'data', 'janus.db'), 'latin1'), /orgmsg:org_alpha/);

  const continuedResearch = await researchService.research({
    organizationId: 'org_alpha', userId: 'user_a', deviceId: 'device_a', prompt: '那第四季度呢', online: false,
    decision: { requiresOrganizationResearch: true, continuesResearchTopic: true, filters: {} },
  });
  assert.equal(continuedResearch.resultId, researchResult.resultId, 'same-topic follow-up must reuse the active research context');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM organization_research_contexts').get().count, 1);

  const saved = cache.saveResearchContext('org_alpha', {
    userId: 'user_a', topicHash: 'topic_a', result: { answer: '加密答案' }, citationIds,
  });
  assert.equal(cache.loadResearchContext('org_alpha', saved.id).result.answer, '加密答案');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'data', 'janus.db'), 'latin1'), /加密答案/);
  currentTime = new Date('2026-08-11T08:31:00.000Z');
  assert.equal(cache.loadResearchContext('org_alpha', saved.id, { forPrompt: true }), null, '30 minute research prompt context must expire');
  assert.equal(cache.loadResearchContext('org_alpha', saved.id).result.answer, '加密答案', 'expired answers remain displayable while access is valid');

  cache.applyChanges('org_alpha', [{ operation: 'tombstone', document: {
    ...changes[3].document, body: '', attachmentNames: [], revision: 2, tombstone: true,
  } }], { cursor: 31 });
  assert.equal(cache.readDocuments('org_alpha').some((item) => item.sourceMessageId === 'message_3'), false);

  currentTime = new Date('2026-08-12T08:00:01.000Z');
  assert.throws(() => cache.search('org_alpha', { query: '预算' }), (error) => error.code === 'organization_research_lease_expired');
  cache.destroy('org_alpha', 'member_removed');
  assert.equal(fs.existsSync(state.encrypted_shard_path), false);
  assert.equal(cache.state('org_alpha').wrapped_data_key, '');
  assert.ok(db.prepare("SELECT COUNT(*) count FROM organization_research_contexts WHERE citation_ids_json<>'[]'").get().count === 0);
  assert.deepEqual(coreInventory(db), beforeInventory, 'core user-data inventory must remain unchanged');

  const unavailable = new EncryptedOrganizationResearchCache({
    db, root, credentialCodec: { status: () => ({ available: false, secure: false, backend: 'unknown' }) },
  });
  assert.throws(() => unavailable.initialize({ organizationId: 'org_b', userId: 'user_a', deviceId: 'device_a' }),
    (error) => error.code === 'secure_storage_unavailable');

  let syncState = { cursor: 0, cache_status: 'ready' };
  let syncCalls = 0;
  const backlogService = new OrganizationResearchService({
    cache: {
      state: () => syncState,
      leaseCredentials: () => ({ id: 'lease', token: 'token', deviceId: 'device', expiresAt: '2026-08-12T10:00:00.000Z' }),
      applyChanges: (_organizationId, _changes, { cursor }) => { syncState = { ...syncState, cursor }; },
      publicState: (value) => value,
    },
    socialRelay: {
      async organizationResearchChanges(_organizationId, { cursor, limit }) {
        syncCalls += 1;
        const nextCursor = Math.min(4_201, cursor + limit);
        return { cursor: nextCursor, changes: [], leaseExpiresAt: '2026-08-12T10:00:00.000Z', hasMore: nextCursor < 4_201 };
      },
    },
    now: () => new Date('2026-08-11T08:00:00.000Z'),
  });
  const backlogSync = await backlogService.sync({ organizationId: 'org_backlog', userId: 'user_a', deviceId: 'device_a' });
  assert.equal(backlogSync.cursor, 4_201);
  assert.equal(backlogSync.hasMore, false);
  assert.equal(syncCalls, 22, 'sync must continue past the former 4,000-change cutoff');

  const migrationCount = db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='organization_message_research_v1'").get().count;
  assert.equal(migrationCount, 1);
  process.stdout.write(JSON.stringify({ status: 'passed', documents: 30, maxHits: 24, maxConversations: 8, plaintextAtRest: false }) + '\n');
} finally {
  cache.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function coreInventory(database) {
  const tables = ['sessions', 'messages', 'memory_documents', 'message_attachments', 'task_runs', 'model_executions', 'cloud_file_manifest'];
  return Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
}
