import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ORGANIZATION_RESEARCH_CONTEXT_TTL_MS,
  ORGANIZATION_RESEARCH_MAX_CONVERSATIONS,
  ORGANIZATION_RESEARCH_MAX_HITS,
  normalizeOrganizationResearchFilters,
  organizationResearchCitationId,
} from '../../../../shared/contracts/organizationMessageResearch.js';

export class EncryptedOrganizationResearchCache {
  constructor({ db, root, credentialCodec, now = () => new Date(), randomBytes = crypto.randomBytes } = {}) {
    this.db = db;
    this.root = path.resolve(String(root || '.'));
    this.credentialCodec = credentialCodec;
    this.now = now;
    this.randomBytes = randomBytes;
    this.memoryIndexes = new Map();
    this.dataKeys = new Map();
    this.cacheDir = path.join(this.root, 'cache', 'organization-research');
  }

  secureStorageStatus() {
    const status = this.credentialCodec?.status?.() || {};
    return { available: status.available === true, secure: status.secure === true, backend: String(status.backend || 'unknown') };
  }

  state(organizationId) {
    return this.db.prepare('SELECT * FROM organization_research_cache_state WHERE organization_id=?').get(String(organizationId || '')) || null;
  }

  initialize({ organizationId, userId, deviceId } = {}) {
    const ids = requiredIds({ organizationId, userId, deviceId });
    this.assertSecureStorage();
    const existing = this.state(ids.organizationId);
    const samePrincipal = existing?.user_id === ids.userId && existing?.device_id === ids.deviceId;
    if (existing && !samePrincipal) this.destroy(ids.organizationId, 'local_principal_changed');
    if (existing && samePrincipal && existing.cache_status !== 'destroyed') {
      this.loadIndex(ids.organizationId);
      return this.publicState(this.state(ids.organizationId));
    }
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const key = this.randomBytes(32);
    const shardPath = this.shardPath(ids.organizationId);
    const wrappedKey = this.wrap(key.toString('base64'));
    const now = this.nowIso();
    this.db.prepare(`INSERT INTO organization_research_cache_state(
      organization_id,user_id,device_id,cursor,wrapped_data_key,encrypted_shard_path,cache_status,created_at,updated_at
    ) VALUES(?,?,?,0,?,?,'empty',?,?) ON CONFLICT(organization_id) DO UPDATE SET
      user_id=excluded.user_id,device_id=excluded.device_id,cursor=0,wrapped_data_key=excluded.wrapped_data_key,
      wrapped_lease_token='',lease_id='',lease_expires_at='',encrypted_shard_path=excluded.encrypted_shard_path,
      cache_status='empty',last_synced_at='',last_error='',updated_at=excluded.updated_at`).run(
      ids.organizationId, ids.userId, ids.deviceId, wrappedKey, shardPath, now, now,
    );
    this.dataKeys.set(ids.organizationId, key);
    this.writeDocuments(ids.organizationId, []);
    this.rebuildIndex(ids.organizationId, []);
    return this.publicState(this.state(ids.organizationId));
  }

  setLease(organizationId, lease = {}) {
    this.assertSecureStorage();
    const state = this.requireState(organizationId);
    const expiresAt = validIso(lease.expiresAt);
    if (!lease.id || !lease.token || !expiresAt || new Date(expiresAt).getTime() <= this.now().getTime()) {
      throw cacheError('organization_research_lease_invalid', 'Organization research lease is invalid.');
    }
    this.db.prepare(`UPDATE organization_research_cache_state SET lease_id=?,wrapped_lease_token=?,lease_expires_at=?,
      cache_status=CASE WHEN cache_status='destroyed' THEN 'empty' ELSE cache_status END,last_error='',updated_at=?
      WHERE organization_id=?`).run(String(lease.id), this.wrap(String(lease.token)), expiresAt, this.nowIso(), state.organization_id);
    return this.publicState(this.state(state.organization_id));
  }

  leaseCredentials(organizationId) {
    const state = this.requireUsableLease(organizationId);
    return { id: state.lease_id, token: this.unwrap(state.wrapped_lease_token), expiresAt: state.lease_expires_at, deviceId: state.device_id };
  }

  applyChanges(organizationId, changes = [], { cursor = null, leaseExpiresAt = '' } = {}) {
    const state = this.requireUsableLease(organizationId);
    const documents = new Map(this.readDocuments(organizationId).map((item) => [documentKey(item), item]));
    for (const change of Array.isArray(changes) ? changes : []) {
      const document = normalizeDocument(change?.document || change);
      if (document.organizationId !== state.organization_id) {
        throw cacheError('organization_research_scope_mismatch', 'A research change belongs to another organization.');
      }
      const key = documentKey(document);
      const existing = documents.get(key);
      if (existing && Number(existing.revision || 0) > document.revision) continue;
      if (document.tombstone || change?.operation === 'tombstone') documents.delete(key);
      else documents.set(key, document);
    }
    const next = [...documents.values()].sort(compareDocuments);
    this.writeDocuments(organizationId, next);
    this.rebuildIndex(organizationId, next);
    const nextCursor = cursor === null ? Number(state.cursor || 0) : Math.max(Number(state.cursor || 0), Number(cursor || 0));
    const nextExpiry = validIso(leaseExpiresAt) || state.lease_expires_at;
    this.db.prepare(`UPDATE organization_research_cache_state SET cursor=?,lease_expires_at=?,cache_status='ready',
      last_synced_at=?,last_error='',updated_at=? WHERE organization_id=?`).run(
      nextCursor, nextExpiry, this.nowIso(), this.nowIso(), state.organization_id,
    );
    return { ...this.publicState(this.state(state.organization_id)), documentCount: next.length };
  }

  search(organizationId, { query = '', filters = {}, mode = 'offline', userId = '', audit = true } = {}) {
    const state = this.requireUsableLease(organizationId);
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) throw cacheError('organization_research_query_required', 'Organization research query is required.');
    const normalizedFilters = normalizeOrganizationResearchFilters(filters);
    const auditEntry = audit ? this.queueAudit(organizationId, {
      query: cleanQuery, filters: normalizedFilters, mode, userId: userId || state.user_id,
    }) : null;
    const index = this.loadIndex(organizationId);
    const params = [];
    const clauses = ['1=1'];
    if (normalizedFilters.personIds.length) {
      const placeholders = normalizedFilters.personIds.map(() => '?').join(',');
      clauses.push(`(sender_user_id IN (${placeholders}) OR sender_display_name IN (${placeholders}))`);
      params.push(...normalizedFilters.personIds, ...normalizedFilters.personIds);
    }
    if (normalizedFilters.conversationIds.length) {
      clauses.push(`conversation_id IN (${normalizedFilters.conversationIds.map(() => '?').join(',')})`);
      params.push(...normalizedFilters.conversationIds);
    }
    if (normalizedFilters.sourceKinds.length) {
      clauses.push(`source_kind IN (${normalizedFilters.sourceKinds.map(() => '?').join(',')})`);
      params.push(...normalizedFilters.sourceKinds);
    }
    if (normalizedFilters.after) { clauses.push('created_at>=?'); params.push(normalizedFilters.after); }
    if (normalizedFilters.before) { clauses.push('created_at<=?'); params.push(normalizedFilters.before); }
    const like = `%${cleanQuery.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    clauses.push(`(body LIKE ? ESCAPE '\\' OR sender_display_name LIKE ? ESCAPE '\\'
      OR conversation_title LIKE ? ESCAPE '\\' OR attachment_names LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
    const candidates = index.prepare(`SELECT * FROM organization_research_fts WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC LIMIT 240`).all(...params).map(rowDocument);
    const hits = diversify(candidates, ORGANIZATION_RESEARCH_MAX_HITS, ORGANIZATION_RESEARCH_MAX_CONVERSATIONS);
    return {
      mode, auditId: auditEntry?.id || '', cacheLastSyncedAt: state.last_synced_at, leaseExpiresAt: state.lease_expires_at,
      hits: hits.map((document) => ({ ...document, citation: citationFor(document) })),
    };
  }

  readContext(organizationId, { sourceKind, messageId } = {}) {
    this.requireUsableLease(organizationId);
    const documents = this.readDocuments(organizationId);
    const hit = documents.find((item) => item.sourceKind === sourceKind && item.sourceMessageId === messageId);
    if (!hit) throw cacheError('organization_research_source_unavailable', 'Research source is unavailable.');
    const conversation = documents.filter((item) => item.conversationId === hit.conversationId).sort(compareDocuments);
    const index = conversation.findIndex((item) => documentKey(item) === documentKey(hit));
    return { source: { ...hit, citation: citationFor(hit) }, messages: conversation.slice(Math.max(0, index - 10), index + 11), bounded: true };
  }

  saveResearchContext(organizationId, { id, userId, topicHash, result, citationIds = [], continuesTopic = false } = {}) {
    const state = this.requireUsableLease(organizationId);
    const now = this.now();
    this.expireContexts(organizationId, userId || state.user_id);
    let contextId = String(id || '');
    if (continuesTopic && topicHash) {
      const active = this.db.prepare(`SELECT * FROM organization_research_contexts
        WHERE organization_id=? AND user_id=? AND topic_hash=? AND status='active' AND expires_at>?
        ORDER BY updated_at DESC LIMIT 1`).get(state.organization_id, userId || state.user_id, topicHash, now.toISOString());
      contextId = active?.id || contextId;
    }
    contextId ||= `org_research_result_${crypto.randomUUID()}`;
    const expiresAt = new Date(now.getTime() + ORGANIZATION_RESEARCH_CONTEXT_TTL_MS).toISOString();
    const encrypted = this.encryptJson(this.dataKey(organizationId), result || {});
    this.db.prepare(`INSERT INTO organization_research_contexts(
      id,organization_id,user_id,topic_hash,encrypted_result,citation_ids_json,created_at,updated_at,expires_at,status
    ) VALUES(?,?,?,?,?,?,?,?,?,'active') ON CONFLICT(id) DO UPDATE SET
      topic_hash=excluded.topic_hash,encrypted_result=excluded.encrypted_result,citation_ids_json=excluded.citation_ids_json,
      updated_at=excluded.updated_at,expires_at=excluded.expires_at,status='active'`).run(
      contextId, state.organization_id, userId || state.user_id, String(topicHash || ''), encrypted,
      '[]', now.toISOString(), now.toISOString(), expiresAt,
    );
    return { id: contextId, expiresAt, placeholder: `[organization-research-result:${contextId}]` };
  }

  latestResearchContext(organizationId, userId = '') {
    const state = this.requireUsableLease(organizationId);
    this.expireContexts(state.organization_id, userId || state.user_id);
    const row = this.db.prepare(`SELECT * FROM organization_research_contexts
      WHERE organization_id=? AND user_id=? AND status='active' AND expires_at>?
      ORDER BY updated_at DESC,id DESC LIMIT 1`).get(
      state.organization_id, userId || state.user_id, this.nowIso(),
    );
    return row ? this.researchContextPayload(organizationId, row) : null;
  }

  loadResearchContext(organizationId, contextId, { forPrompt = false } = {}) {
    const state = this.requireUsableLease(organizationId);
    const row = this.db.prepare(`SELECT * FROM organization_research_contexts
      WHERE id=? AND organization_id=? AND user_id=?`).get(String(contextId || ''), state.organization_id, state.user_id);
    if (!row || row.status === 'locked') return null;
    const promptEligible = row.status === 'active' && new Date(row.expires_at).getTime() > this.now().getTime();
    if (forPrompt && !promptEligible) return null;
    return this.researchContextPayload(organizationId, row);
  }

  queueAudit(organizationId, { query, filters = {}, mode = 'offline', userId = '' } = {}) {
    const state = this.requireUsableLease(organizationId);
    const createdAt = this.nowIso();
    const id = `org_research_audit_${crypto.randomUUID()}`;
    const idempotencyKey = sha256(`${state.organization_id}\u001f${state.device_id}\u001f${id}`);
    const payload = {
      idempotencyKey, deviceId: state.device_id, mode: ['online', 'offline', 'fallback'].includes(mode) ? mode : 'offline',
      queryHash: sha256(String(query || '')), filters, resultCount: 0, citationIds: [], createdAt,
    };
    this.db.prepare(`INSERT INTO organization_research_audit_outbox(
      id,idempotency_key,organization_id,user_id,device_id,encrypted_payload,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,'pending',?,?)`).run(
      id, idempotencyKey, state.organization_id, userId || state.user_id, state.device_id,
      this.encryptJson(this.dataKey(organizationId), payload), createdAt, createdAt,
    );
    return { id, idempotencyKey };
  }

  completeAudit(auditId, { resultCount = 0, citationIds = [], mode = '' } = {}) {
    const row = this.db.prepare('SELECT * FROM organization_research_audit_outbox WHERE id=?').get(String(auditId || ''));
    if (!row) return null;
    const payload = this.decryptJson(this.dataKey(row.organization_id), row.encrypted_payload);
    payload.resultCount = Math.max(0, Math.min(24, Number(resultCount || 0)));
    payload.citationIds = [...new Set(citationIds.map(String))].slice(0, 24);
    if (['online', 'offline', 'fallback'].includes(mode)) payload.mode = mode;
    this.db.prepare('UPDATE organization_research_audit_outbox SET encrypted_payload=?,updated_at=? WHERE id=?').run(
      this.encryptJson(this.dataKey(row.organization_id), payload), this.nowIso(), row.id,
    );
    return payload;
  }

  async flushAuditOutbox(organizationId, uploader) {
    this.requireUsableLease(organizationId);
    const rows = this.db.prepare(`SELECT * FROM organization_research_audit_outbox
      WHERE organization_id=? AND status IN ('pending','failed') AND (next_attempt_at='' OR next_attempt_at<=?)
      ORDER BY created_at,id LIMIT 100`).all(String(organizationId), this.nowIso());
    let completed = 0;
    for (const row of rows) {
      this.db.prepare("UPDATE organization_research_audit_outbox SET status='sending',attempt_count=attempt_count+1,updated_at=? WHERE id=?")
        .run(this.nowIso(), row.id);
      try {
        const payload = this.decryptJson(this.dataKey(organizationId), row.encrypted_payload);
        await uploader(payload);
        this.db.prepare("UPDATE organization_research_audit_outbox SET status='completed',completed_at=?,updated_at=?,last_error='' WHERE id=?")
          .run(this.nowIso(), this.nowIso(), row.id);
        completed += 1;
      } catch (error) {
        const nextAttempt = new Date(this.now().getTime() + 60_000).toISOString();
        this.db.prepare("UPDATE organization_research_audit_outbox SET status='failed',next_attempt_at=?,last_error=?,updated_at=? WHERE id=?")
          .run(nextAttempt, String(error?.message || error).slice(0, 1000), this.nowIso(), row.id);
      }
    }
    return { attempted: rows.length, completed };
  }

  destroy(organizationId, reason = 'access_revoked') {
    const id = String(organizationId || '');
    const state = this.state(id);
    this.memoryIndexes.get(id)?.close?.();
    this.memoryIndexes.delete(id);
    this.dataKeys.delete(id);
    if (state?.encrypted_shard_path) {
      try { fs.rmSync(state.encrypted_shard_path, { force: true }); } catch {}
    }
    if (state) this.db.prepare(`UPDATE organization_research_cache_state SET cursor=0,wrapped_data_key='',wrapped_lease_token='',
      lease_id='',lease_expires_at='',cache_status='destroyed',last_error=?,updated_at=? WHERE organization_id=?`)
      .run(String(reason || '').slice(0, 500), this.nowIso(), id);
    this.db.prepare("UPDATE organization_research_contexts SET status='locked',encrypted_result='',citation_ids_json='[]' WHERE organization_id=?").run(id);
    this.db.prepare("DELETE FROM organization_research_audit_outbox WHERE organization_id=? AND status!='completed'").run(id);
    return { organizationId: id, destroyed: true, reason };
  }

  destroyAll(reason = 'local_logout') {
    const rows = this.db.prepare('SELECT organization_id FROM organization_research_cache_state').all();
    return rows.map((row) => this.destroy(row.organization_id, reason));
  }

  close() {
    for (const index of this.memoryIndexes.values()) index.close();
    this.memoryIndexes.clear();
    this.dataKeys.clear();
  }

  expireContexts(organizationId, userId) {
    this.db.prepare(`UPDATE organization_research_contexts SET status='expired'
      WHERE organization_id=? AND user_id=? AND status='active' AND expires_at<=?`).run(organizationId, userId, this.nowIso());
  }

  loadIndex(organizationId) {
    this.requireUsableLease(organizationId, { allowMissingLease: true });
    if (!this.memoryIndexes.has(organizationId)) this.rebuildIndex(organizationId, this.readDocuments(organizationId));
    return this.memoryIndexes.get(organizationId);
  }

  rebuildIndex(organizationId, documents) {
    this.memoryIndexes.get(organizationId)?.close?.();
    const index = new DatabaseSync(':memory:');
    index.exec(`CREATE VIRTUAL TABLE organization_research_fts USING fts5(
      source_kind UNINDEXED,source_message_id UNINDEXED,organization_id UNINDEXED,conversation_id UNINDEXED,
      conversation_title,sender_user_id UNINDEXED,sender_display_name,body,attachment_names,
      created_at UNINDEXED,updated_at UNINDEXED,revision UNINDEXED,tokenize='trigram'
    )`);
    const insert = index.prepare(`INSERT INTO organization_research_fts(
      source_kind,source_message_id,organization_id,conversation_id,conversation_title,sender_user_id,
      sender_display_name,body,attachment_names,created_at,updated_at,revision
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const document of documents) insert.run(
      document.sourceKind, document.sourceMessageId, document.organizationId, document.conversationId,
      document.conversationTitle, document.senderUserId, document.senderDisplayName, document.body,
      document.attachmentNames.join('\n'), document.createdAt, document.updatedAt, document.revision,
    );
    this.memoryIndexes.set(organizationId, index);
    return index;
  }

  readDocuments(organizationId) {
    const state = this.requireState(organizationId);
    if (!fs.existsSync(state.encrypted_shard_path)) return [];
    const envelope = fs.readFileSync(state.encrypted_shard_path, 'utf8');
    const value = this.decryptJson(this.dataKey(organizationId), envelope);
    return Array.isArray(value?.documents) ? value.documents.map(normalizeDocument) : [];
  }

  writeDocuments(organizationId, documents) {
    const state = this.requireState(organizationId);
    fs.mkdirSync(path.dirname(state.encrypted_shard_path), { recursive: true, mode: 0o700 });
    const encrypted = this.encryptJson(this.dataKey(organizationId), { version: 1, documents });
    const temporary = `${state.encrypted_shard_path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, state.encrypted_shard_path);
  }

  dataKey(organizationId) {
    const id = String(organizationId || '');
    if (this.dataKeys.has(id)) return this.dataKeys.get(id);
    this.assertSecureStorage();
    const state = this.requireState(id);
    if (!state.wrapped_data_key) throw cacheError('organization_research_cache_locked', 'Organization research cache key is unavailable.');
    const key = Buffer.from(this.unwrap(state.wrapped_data_key), 'base64');
    if (key.length !== 32) throw cacheError('organization_research_cache_locked', 'Organization research cache key is invalid.');
    this.dataKeys.set(id, key);
    return key;
  }

  encryptJson(key, value) {
    const iv = this.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  }

  decryptJson(key, envelopeText) {
    try {
      const envelope = JSON.parse(String(envelopeText || ''));
      if (envelope.v !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('unsupported envelope');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch (error) {
      throw cacheError('organization_research_cache_decryption_failed', `Organization research cache could not be decrypted: ${error.message || error}`);
    }
  }

  requireUsableLease(organizationId, { allowMissingLease = false } = {}) {
    const state = this.requireState(organizationId);
    if (state.cache_status === 'destroyed' || !state.wrapped_data_key) throw cacheError('organization_research_cache_locked', 'Organization research cache is locked.');
    if (allowMissingLease && !state.lease_expires_at) return state;
    if (!state.lease_expires_at || new Date(state.lease_expires_at).getTime() <= this.now().getTime()) {
      this.db.prepare("UPDATE organization_research_cache_state SET cache_status='locked',last_error='lease_expired',updated_at=? WHERE organization_id=?")
        .run(this.nowIso(), state.organization_id);
      throw cacheError('organization_research_lease_expired', 'Organization research lease has expired.');
    }
    return state;
  }

  requireState(organizationId) {
    const state = this.state(organizationId);
    if (!state) throw cacheError('organization_research_cache_missing', 'Organization research cache is not initialized.');
    return state;
  }

  assertSecureStorage() {
    const status = this.secureStorageStatus();
    if (!status.available || !status.secure) throw cacheError('secure_storage_unavailable', 'Secure credential storage is required for organization research.');
  }

  wrap(value) { return this.credentialCodec.encrypt(String(value || '')); }
  unwrap(value) { return this.credentialCodec.decrypt(String(value || '')); }
  researchContextPayload(organizationId, row) {
    const result = this.decryptJson(this.dataKey(organizationId), row.encrypted_result);
    const citationIds = [...new Set([
      ...(Array.isArray(result?.citationIds) ? result.citationIds : []),
      ...(Array.isArray(result?.citations) ? result.citations.map((item) => item?.id) : []),
    ].map(String).filter(Boolean))];
    return { ...row, result, citationIds };
  }
  shardPath(organizationId) { return path.join(this.cacheDir, `${sha256(organizationId)}.research-cache`); }
  nowIso() { return this.now().toISOString(); }
  publicState(state) {
    return state ? {
      organizationId: state.organization_id, userId: state.user_id, deviceId: state.device_id,
      cursor: Number(state.cursor || 0), leaseId: state.lease_id, leaseExpiresAt: state.lease_expires_at,
      cacheStatus: state.cache_status, lastSyncedAt: state.last_synced_at, lastError: state.last_error,
    } : null;
  }
}

function requiredIds(value) {
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item || '').trim()]));
  if (Object.values(result).some((item) => !item)) throw cacheError('organization_research_identity_required', 'Organization, user, and device identities are required.');
  return result;
}

function normalizeDocument(value = {}) {
  return {
    organizationId: String(value.organizationId || ''), sourceKind: String(value.sourceKind || ''),
    sourceMessageId: String(value.sourceMessageId || value.messageId || ''), conversationId: String(value.conversationId || ''),
    conversationTitle: String(value.conversationTitle || ''), senderUserId: String(value.senderUserId || ''),
    senderDisplayName: String(value.senderDisplayName || ''), body: String(value.body || ''),
    attachmentNames: (Array.isArray(value.attachmentNames) ? value.attachmentNames : []).map(String),
    createdAt: validIso(value.createdAt), updatedAt: validIso(value.updatedAt) || validIso(value.createdAt),
    revision: Math.max(1, Number(value.revision || 1)), tombstone: value.tombstone === true,
  };
}

function rowDocument(row) {
  return normalizeDocument({
    organizationId: row.organization_id, sourceKind: row.source_kind, sourceMessageId: row.source_message_id,
    conversationId: row.conversation_id, conversationTitle: row.conversation_title, senderUserId: row.sender_user_id,
    senderDisplayName: row.sender_display_name, body: row.body, attachmentNames: String(row.attachment_names || '').split('\n').filter(Boolean),
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
  });
}

function citationFor(document) {
  return {
    id: organizationResearchCitationId(document), organizationId: document.organizationId,
    sourceKind: document.sourceKind, conversationId: document.conversationId,
    messageId: document.sourceMessageId, author: document.senderDisplayName || document.senderUserId,
    timestamp: document.createdAt, attachmentNames: document.attachmentNames,
  };
}

function diversify(candidates, maxHits, maxConversations) {
  const conversationIds = [];
  const grouped = new Map();
  for (const item of candidates) {
    if (!grouped.has(item.conversationId)) {
      if (conversationIds.length >= maxConversations) continue;
      conversationIds.push(item.conversationId);
      grouped.set(item.conversationId, []);
    }
    grouped.get(item.conversationId).push(item);
  }
  const result = [];
  while (result.length < maxHits) {
    let added = false;
    for (const id of conversationIds) {
      const item = grouped.get(id).shift();
      if (item) { result.push(item); added = true; }
      if (result.length >= maxHits) break;
    }
    if (!added) break;
  }
  return result;
}

function documentKey(document) { return `${document.sourceKind}\u001f${document.sourceMessageId}`; }
function compareDocuments(left, right) { return String(left.createdAt).localeCompare(String(right.createdAt)) || documentKey(left).localeCompare(documentKey(right)); }
function validIso(value) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toISOString() : ''; }
function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function cacheError(code, message) { const error = new Error(message); error.code = code; return error; }
