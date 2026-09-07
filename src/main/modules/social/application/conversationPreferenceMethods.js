import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';

const CONVERSATION_KINDS = new Set(['chat_group', 'collaboration_group']);
const INBOX_KINDS = new Set(['social_direct', 'agent_session']);

export function installConversationPreferenceMethods(prototype) {
  Object.assign(prototype, {
    conversationPreferencesOverview() {
      const user = this.requireUser();
      const inbox = all(this.db, `SELECT * FROM social_inbox_preferences WHERE user_id=? ORDER BY updated_at DESC`, [user.id]).map(normalizePreference);
      return {
        capability: 'conversation-inbox-archive-v1',
        preferences: [...all(this.db, `SELECT * FROM social_conversation_preferences
          WHERE user_id=? ORDER BY updated_at DESC,conversation_kind,conversation_id`, [user.id]).map(normalizePreference), ...inbox],
      };
    },

    conversationPreference({ conversationKind = '', conversationId = '' } = {}) {
      const user = this.requireUser();
      const kind = normalizeConversationKind(conversationKind);
      const id = String(conversationId || '').trim();
      if (!id) return null;
      return normalizePreference(get(this.db, `SELECT * FROM social_conversation_preferences
        WHERE user_id=? AND conversation_kind=? AND conversation_id=?
        ORDER BY updated_at DESC LIMIT 1`, [user.id, kind, id]));
    },

    decorateConversationGroups(groups = [], conversationKind = '') {
      const user = this.requireUser();
      const kind = normalizeConversationKind(conversationKind);
      const preferences = new Map(all(this.db, `SELECT * FROM social_conversation_preferences
        WHERE user_id=? AND conversation_kind=?`, [user.id, kind])
        .map(normalizePreference).map((item) => [item.conversationId, item]));
      return (Array.isArray(groups) ? groups : []).map((group) => {
        const id = String(group?.id || '').trim();
        const preference = preferences.get(id) || null;
        const ended = kind === 'chat_group' ? group?.status === 'dissolved' : group?.status === 'closed';
        const groupUpdatedAt = Date.parse(group?.updatedAt || group?.updated_at || '');
        const preferenceUpdatedAt = Date.parse(preference?.updatedAt || '');
        const autoReopened = Boolean(preference?.archived && !ended
          && Number.isFinite(groupUpdatedAt) && Number.isFinite(preferenceUpdatedAt)
          && groupUpdatedAt > preferenceUpdatedAt);
        return {
          ...group,
          archived: Boolean((preference?.archived || preference?.removedAt) && !autoReopened),
          archiveRevision: Number(preference?.stateRevision || 0),
          archiveUpdatedAt: preference?.updatedAt || '',
          archiveAutoReopened: autoReopened,
          removed: false,
        };
      });
    },

    setConversationArchived({ conversationKind = '', conversationId = '', archived = true, removed = false, commandId = '', expectedRevision, sourceDeviceId = '', workspaceId = '' } = {}) {
      const user = this.requireUser();
      const kind = normalizeConversationKind(conversationKind);
      const id = String(conversationId || '').trim();
      if (!id) throw conversationPreferenceError('conversation_preference_identity_required', '缺少需要归档的会话。');
      if (INBOX_KINDS.has(kind)) return setInboxArchived(this, { user, kind, id, archived, commandId, expectedRevision, sourceDeviceId, workspaceId });
      const target = requireConversationMembership(this.db, { userId: user.id, conversationKind: kind, conversationId: id });
      const ended = kind === 'chat_group' ? target.status === 'dissolved' : target.status === 'closed';
      if (removed && !ended) throw conversationPreferenceError('conversation_remove_active_forbidden', '只能归档已结束的群聊。');
      const archiveOnly = Boolean(archived || removed);
      const cleanCommandId = String(commandId || '').trim().slice(0, 200) || newId('conversation_archive');
      const current = normalizePreference(get(this.db, `SELECT * FROM social_conversation_preferences
        WHERE account_workspace_id=? AND user_id=? AND conversation_kind=? AND conversation_id=?`, [target.workspaceId, user.id, kind, id]));
      const payload = {
        workspaceId: target.workspaceId,
        conversationKind: kind,
        conversationId: id,
        archived: archiveOnly,
        removed: false,
        commandId: cleanCommandId,
        expectedRevision: expectedRevision == null ? Number(current?.stateRevision || 0) : Number(expectedRevision),
      };
      const payloadHash = hashPayload(payload);
      const prior = get(this.db, 'SELECT payload_hash FROM social_conversation_preference_outbox WHERE command_id=?', [cleanCommandId]);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw conversationPreferenceError('conversation_preference_idempotency_conflict', '会话归档命令已被不同请求占用。');
        return { preference: this.conversationPreference({ conversationKind: kind, conversationId: id }), idempotent: true };
      }
      const currentRevision = Number(current?.stateRevision || 0);
      if (expectedRevision != null && (!Number.isInteger(Number(expectedRevision)) || Number(expectedRevision) < 0)) {
        throw conversationPreferenceError('conversation_preference_revision_invalid', '会话归档版本号无效。');
      }
      if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
        throw conversationPreferenceError('conversation_preference_conflict', '会话归档状态已在其他设备更新，请刷新后重试。', { currentRevision });
      }
      const nextRevision = currentRevision + 1;
      const now = nowIso();
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `INSERT INTO social_conversation_preferences(
          account_workspace_id,user_id,conversation_kind,conversation_id,archived,removed_at,state_revision,base_state_revision,
          last_command_id,source_device_id,sync_status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(account_workspace_id,user_id,conversation_kind,conversation_id) DO UPDATE SET
          archived=excluded.archived,removed_at=excluded.removed_at,state_revision=excluded.state_revision,base_state_revision=excluded.base_state_revision,
          last_command_id=excluded.last_command_id,source_device_id=excluded.source_device_id,sync_status='pending',updated_at=excluded.updated_at`, [
          target.workspaceId, user.id, kind, id, archiveOnly ? 1 : 0, '', nextRevision, currentRevision,
          cleanCommandId, String(sourceDeviceId || 'local'), current?.createdAt || now, now,
        ]);
        run(this.db, `INSERT INTO social_conversation_preference_outbox(
          id,account_workspace_id,user_id,conversation_kind,conversation_id,command_id,payload_hash,payload_json,status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`, [
          newId('conversation_preference_outbox'), target.workspaceId, user.id, kind, id, cleanCommandId,
          payloadHash, JSON.stringify({ ...payload, stateRevision: nextRevision }), now, now,
        ]);
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return { preference: this.conversationPreference({ conversationKind: kind, conversationId: id }) };
    },

    listConversationPreferenceOutbox({ limit = 100 } = {}) {
      const user = this.requireUser();
      const legacy = all(this.db, `SELECT * FROM social_conversation_preference_outbox
        WHERE user_id=? AND status IN ('pending','failed') AND (next_attempt_at='' OR next_attempt_at<=?)
        ORDER BY created_at,id LIMIT ?`, [user.id, nowIso(), Math.max(1, Math.min(500, Number(limit) || 100))])
        .map((row) => ({ ...row, payload: parseJson(row.payload_json) }));
      const inbox = all(this.db, `SELECT * FROM social_inbox_preference_outbox
        WHERE user_id=? AND status IN ('pending','failed') AND (next_attempt_at='' OR next_attempt_at<=?)
        ORDER BY created_at,id LIMIT ?`, [user.id, nowIso(), Math.max(1, Math.min(500, Number(limit) || 100))])
        .map((row) => ({ ...row, payload: parseJson(row.payload_json), inboxPreference: true }));
      return [...legacy, ...inbox].slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
    },

    markConversationPreferenceOutbox({ id = '', status = 'completed', error = '' } = {}) {
      const now = nowIso();
      const cleanStatus = status === 'completed' ? 'completed' : 'failed';
      const table = String(id || '').startsWith('social_inbox_archive') ? 'social_inbox_preference_outbox' : 'social_conversation_preference_outbox';
      run(this.db, `UPDATE ${table} SET status=?,attempt_count=attempt_count+1,
        last_error=?,updated_at=?,completed_at=? WHERE id=?`, [cleanStatus, String(error || '').slice(0, 1000), now,
        cleanStatus === 'completed' ? now : '', String(id || '')]);
      return true;
    },

    importCloudConversationPreferences(result = {}) {
      const user = this.requireUser();
      const items = result.preference ? [result.preference] : Array.isArray(result.preferences) ? result.preferences : [];
      for (const item of items) {
        const kind = normalizeConversationKind(item.conversationKind || item.conversation_kind);
        const id = String(item.conversationId || item.conversation_id || '').trim();
        if (!id) continue;
        const existingTarget = conversationTarget(this.db, kind, id);
        const workspaceId = existingTarget?.workspaceId || String(item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal');
        const revision = Math.max(1, Number(item.stateRevision || item.state_revision || item.revision || 1));
        const now = item.updatedAt || item.updated_at || nowIso();
        run(this.db, `INSERT INTO social_conversation_preferences(
          account_workspace_id,user_id,conversation_kind,conversation_id,archived,removed_at,state_revision,base_state_revision,
          last_command_id,source_device_id,sync_status,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,'synced',?,?) ON CONFLICT(account_workspace_id,user_id,conversation_kind,conversation_id) DO UPDATE SET
          archived=excluded.archived,removed_at=excluded.removed_at,state_revision=excluded.state_revision,base_state_revision=excluded.state_revision,
          last_command_id=excluded.last_command_id,source_device_id=excluded.source_device_id,sync_status='synced',updated_at=excluded.updated_at
        WHERE excluded.state_revision>=social_conversation_preferences.state_revision`, [
          workspaceId, user.id, kind, id, item.archived || item.removedAt || item.removed_at ? 1 : 0, '', revision, revision,
          item.lastCommandId || item.last_command_id || '', item.sourceDeviceId || item.source_device_id || 'cloud',
          item.createdAt || item.created_at || now, now,
        ]);
      }
      return this.conversationPreferencesOverview();
    },
  });
}

function normalizeConversationKind(value = '') {
  const kind = String(value || '').trim();
  if (!CONVERSATION_KINDS.has(kind) && !INBOX_KINDS.has(kind)) throw conversationPreferenceError('conversation_preference_kind_invalid', '不支持的会话归档类型。');
  return kind;
}

function requireConversationMembership(db, input = {}) {
  const target = conversationTarget(db, input.conversationKind, input.conversationId);
  if (!target) throw conversationPreferenceError('conversation_preference_not_found', '会话不存在。');
  const membershipTable = input.conversationKind === 'chat_group' ? 'chat_group_members' : 'collaboration_group_members';
  const membership = get(db, `SELECT status FROM ${membershipTable} WHERE group_id=? AND user_id=?`, [input.conversationId, input.userId]);
  if (!membership || !['active', 'left', 'removed', 'closed'].includes(String(membership.status || 'active'))) {
    throw conversationPreferenceError('conversation_preference_forbidden', '你无权管理这个会话。');
  }
  return target;
}

function conversationTarget(db, conversationKind = '', conversationId = '') {
  const table = conversationKind === 'chat_group' ? 'chat_groups' : conversationKind === 'collaboration_group' ? 'collaboration_groups' : '';
  if (!table) return null;
  const row = get(db, `SELECT account_workspace_id,status,updated_at FROM ${table} WHERE id=?`, [conversationId]);
  return row ? { workspaceId: row.account_workspace_id || 'workspace_personal', status: row.status || '', updatedAt: row.updated_at || '' } : null;
}

function normalizePreference(row) {
  if (!row) return null;
  return {
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    userId: row.user_id || '',
    conversationKind: row.conversation_kind || '',
    conversationId: row.conversation_id || '',
    archived: Boolean(row.archived || row.removed_at),
    removed: false,
    removedAt: '',
    stateRevision: Number(row.state_revision || 0),
    baseStateRevision: Number(row.base_state_revision || 0),
    lastCommandId: row.last_command_id || '',
    sourceDeviceId: row.source_device_id || '',
    syncStatus: row.sync_status || 'pending',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function hashPayload(payload = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function setInboxArchived(auth, { user, kind, id, archived, commandId = '', expectedRevision, sourceDeviceId = '', workspaceId = '' }) {
  const target = kind === 'agent_session'
    ? get(auth.db, `SELECT id,account_workspace_id FROM sessions WHERE id=? AND user_id=? AND status!='deleted'`, [id, user.id])
    : get(auth.db, `SELECT id FROM social_direct_conversations WHERE id=? AND (user_a_id=? OR user_b_id=?)`, [id, user.id, user.id]);
  if (!target) throw conversationPreferenceError('conversation_preference_not_found', '会话不存在或你无权管理。');
  const targetWorkspaceId = target.account_workspace_id || String(workspaceId || '').trim() || 'workspace_personal';
  const current = get(auth.db, `SELECT * FROM social_inbox_preferences WHERE account_workspace_id=? AND user_id=? AND conversation_kind=? AND conversation_id=?`, [targetWorkspaceId, user.id, kind, id]);
  const revision = Number(current?.state_revision || 0);
  if (expectedRevision != null && Number(expectedRevision) !== revision) throw conversationPreferenceError('conversation_preference_conflict', '会话归档状态已在其他设备更新，请刷新后重试。', { currentRevision: revision });
  const now = nowIso();
  const next = revision + 1;
  const command = String(commandId || '').trim().slice(0, 200) || newId('conversation_archive');
  const payload = { workspaceId: targetWorkspaceId, conversationKind: kind, conversationId: id, archived: Boolean(archived), removed: false, commandId: command, expectedRevision: revision, stateRevision: next };
  const owns = !auth.db.isTransaction;
  if (owns) auth.db.exec('BEGIN IMMEDIATE');
  try {
    run(auth.db, `INSERT INTO social_inbox_preferences(account_workspace_id,user_id,conversation_kind,conversation_id,archived,state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_workspace_id,user_id,conversation_kind,conversation_id) DO UPDATE SET archived=excluded.archived,state_revision=excluded.state_revision,last_command_id=excluded.last_command_id,source_device_id=excluded.source_device_id,sync_status='pending',updated_at=excluded.updated_at`, [targetWorkspaceId,user.id,kind,id,payload.archived?1:0,next,command,String(sourceDeviceId||'local'),'pending',current?.created_at||now,now]);
    run(auth.db, `INSERT INTO social_inbox_preference_outbox(id,account_workspace_id,user_id,conversation_kind,conversation_id,command_id,payload_hash,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`, [newId('social_inbox_archive'),targetWorkspaceId,user.id,kind,id,command,hashPayload(payload),JSON.stringify(payload),now,now]);
    if (owns) auth.db.exec('COMMIT');
  } catch (error) { if (owns) auth.db.exec('ROLLBACK'); throw error; }
  return { preference: normalizePreference(get(auth.db, `SELECT * FROM social_inbox_preferences WHERE account_workspace_id=? AND user_id=? AND conversation_kind=? AND conversation_id=?`, [targetWorkspaceId,user.id,kind,id])) };
}

function parseJson(value = '') {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function conversationPreferenceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}
