import { get, all, run } from '../../../db.js';
import { newId, nowIso, sha256Text } from '../../../utils.js';

export function installChatContextStateStoreMethods(prototype) {
  Object.assign(prototype, {
    chatContextStateId({ ownerUserId = '', sessionId = '', contextSpaceId = '' } = {}) {
      return stableChatContextStateId(ownerUserId, sessionId, contextSpaceId);
    },

    ensureChatContextState({ ownerUserId = '', sessionId = '', contextSpaceId = '', sourceDeviceId = '' } = {}) {
      if (!ownerUserId || !sessionId) throw new Error('Chat context state requires an owner and session.');
      const existing = get(this.db, `SELECT * FROM chat_context_states
        WHERE owner_user_id=? AND session_id=? AND context_space_id=?`, [ownerUserId, sessionId, contextSpaceId]);
      if (existing) return normalizeChatContextState(existing);
      const id = collisionSafeChatContextStateId(this.db, {
        ownerUserId, sessionId, contextSpaceId,
        preferredId: stableChatContextStateId(ownerUserId, sessionId, contextSpaceId),
      });
      const now = nowIso();
      run(this.db, `INSERT INTO chat_context_states(
        id,owner_user_id,session_id,context_space_id,context_epoch,state_revision,base_state_revision,
        last_command_id,source_device_id,sync_status,created_at,updated_at
      ) VALUES(?,?,?,?,1,1,0,?,?, 'pending',?,?)
      ON CONFLICT(owner_user_id,session_id,context_space_id) DO NOTHING`, [
        id, ownerUserId, sessionId, contextSpaceId, newId('chat_context_created'), sourceDeviceId, now, now,
      ]);
      const created = get(this.db, `SELECT * FROM chat_context_states
        WHERE owner_user_id=? AND session_id=? AND context_space_id=?`, [ownerUserId, sessionId, contextSpaceId]);
      if (!created) throw chatContextStateCollisionError({ ownerUserId, sessionId, contextSpaceId, id });
      return normalizeChatContextState(created);
    },

    getChatContextState({ ownerUserId = '', sessionId = '', contextSpaceId = '', sourceDeviceId = '' } = {}) {
      return this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId, sourceDeviceId });
    },

    resetChatContext({
      ownerUserId = '', sessionId = '', contextSpaceId = '', commandId = '', expectedStateRevision = null,
      sourceDeviceId = '', boundaryMessageId = '', boundaryCreatedAt = '',
    } = {}) {
      const current = this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId, sourceDeviceId });
      if (commandId && current.lastCommandId === commandId) return current;
      if (expectedStateRevision != null && Number(expectedStateRevision) !== current.stateRevision) {
        const error = new Error('Chat context state changed on another device.');
        error.code = 'chat_context_state_conflict';
        error.details = { expectedStateRevision: Number(expectedStateRevision), current };
        throw error;
      }
      const where = ['session_id=?', 'visible=1'];
      const params = [sessionId];
      if (contextSpaceId) {
        where.push('context_space_id=?');
        params.push(contextSpaceId);
      }
      const boundary = boundaryMessageId || boundaryCreatedAt
        ? { id: boundaryMessageId, created_at: boundaryCreatedAt }
        : get(this.db, `SELECT id,created_at FROM messages WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC,id DESC LIMIT 1`, params) || {};
      const baseRevision = current.syncStatus === 'synced' ? current.stateRevision : current.baseStateRevision;
      const now = nowIso();
      run(this.db, `UPDATE chat_context_states SET context_epoch=context_epoch+1,
        reset_after_message_id=?,reset_after_created_at=?,last_execution_id='',last_input_tokens=0,
        provider_compaction_detected=0,state_revision=state_revision+1,base_state_revision=?,last_command_id=?,
        source_device_id=?,sync_status='pending',updated_at=? WHERE id=?`, [
        boundary.id || '', boundary.created_at || now, baseRevision, commandId || newId('chat_context_compress'),
        sourceDeviceId, now, current.id,
      ]);
      return normalizeChatContextState(get(this.db, 'SELECT * FROM chat_context_states WHERE id=?', [current.id]));
    },

    recordChatContextUsage({
      ownerUserId = '', sessionId = '', contextSpaceId = '', executionId = '', inputTokens = 0,
      contextWindowTokens = 0, sourceDeviceId = '',
    } = {}) {
      const current = this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId, sourceDeviceId });
      const baseRevision = current.syncStatus === 'synced' ? current.stateRevision : current.baseStateRevision;
      const now = nowIso();
      run(this.db, `UPDATE chat_context_states SET last_execution_id=?,last_input_tokens=?,context_window_tokens=?,
        state_revision=state_revision+1,base_state_revision=?,last_command_id=?,source_device_id=?,sync_status='pending',updated_at=?
        WHERE id=?`, [executionId, nonNegativeInteger(inputTokens), nonNegativeInteger(contextWindowTokens), baseRevision,
        newId('chat_context_usage'), sourceDeviceId, now, current.id]);
      return normalizeChatContextState(get(this.db, 'SELECT * FROM chat_context_states WHERE id=?', [current.id]));
    },

    markChatContextProviderCompaction({ ownerUserId = '', sessionId = '', contextSpaceId = '', sourceDeviceId = '' } = {}) {
      const current = this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId, sourceDeviceId });
      if (current.providerCompactionDetected) return current;
      const baseRevision = current.syncStatus === 'synced' ? current.stateRevision : current.baseStateRevision;
      const now = nowIso();
      run(this.db, `UPDATE chat_context_states SET provider_compaction_detected=1,state_revision=state_revision+1,
        base_state_revision=?,last_command_id=?,source_device_id=?,sync_status='pending',updated_at=? WHERE id=?`, [
        baseRevision, newId('provider_compaction'), sourceDeviceId, now, current.id,
      ]);
      return normalizeChatContextState(get(this.db, 'SELECT * FROM chat_context_states WHERE id=?', [current.id]));
    },

    recordChatContextNativeCompaction({
      ownerUserId = '', sessionId = '', contextSpaceId = '', commandId = '', contextWindowTokens = 0,
      expectedStateRevision = null, sourceDeviceId = '',
    } = {}) {
      const current = this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId, sourceDeviceId });
      if (commandId && current.lastCommandId === commandId) return current;
      if (expectedStateRevision != null && Number(expectedStateRevision) !== current.stateRevision) {
        const error = new Error('Chat context state changed on another device.');
        error.code = 'chat_context_state_conflict';
        error.details = { expectedStateRevision: Number(expectedStateRevision), current };
        throw error;
      }
      const baseRevision = current.syncStatus === 'synced' ? current.stateRevision : current.baseStateRevision;
      const now = nowIso();
      run(this.db, `UPDATE chat_context_states SET last_execution_id='',last_input_tokens=0,context_window_tokens=?,
        provider_compaction_detected=1,state_revision=state_revision+1,base_state_revision=?,last_command_id=?,
        source_device_id=?,sync_status='pending',updated_at=? WHERE id=?`, [
        nonNegativeInteger(contextWindowTokens || current.contextWindowTokens), baseRevision,
        commandId || newId('chat_context_native_compaction'), sourceDeviceId, now, current.id,
      ]);
      return normalizeChatContextState(get(this.db, 'SELECT * FROM chat_context_states WHERE id=?', [current.id]));
    },

    acknowledgeChatContextCompaction({
      ownerUserId = '', sessionId = '', contextSpaceId = '', executionId = '', sourceDeviceId = '',
    } = {}) {
      const current = this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId, sourceDeviceId });
      if (!current.providerCompactionDetected) return current;
      if (executionId && current.lastExecutionId && current.lastExecutionId !== executionId) return current;
      const baseRevision = current.syncStatus === 'synced' ? current.stateRevision : current.baseStateRevision;
      const now = nowIso();
      run(this.db, `UPDATE chat_context_states SET provider_compaction_detected=0,state_revision=state_revision+1,
        base_state_revision=?,last_command_id=?,source_device_id=?,sync_status='pending',updated_at=? WHERE id=?`, [
        baseRevision, newId('chat_context_compaction_ack'), sourceDeviceId, now, current.id,
      ]);
      return normalizeChatContextState(get(this.db, 'SELECT * FROM chat_context_states WHERE id=?', [current.id]));
    },

    listMessagesForPrompt(sessionId, { ownerUserId = '', contextSpaceId = '', includeAllContexts = true } = {}) {
      const session = this.getSession?.(sessionId) || null;
      const canonicalConversationId = session?.agentInstanceId
        ? String(session.conversationId || session.id || '').trim()
        : '';
      const identityWhere = canonicalConversationId ? 'conversation_id=?' : 'session_id=?';
      const identityValue = canonicalConversationId || sessionId;
      const state = ownerUserId
        ? this.ensureChatContextState({ ownerUserId, sessionId, contextSpaceId })
        : null;
      const summaryWhere = [identityWhere, 'visible=0'];
      const summaryParams = [identityValue];
      if (!includeAllContexts && contextSpaceId) {
        summaryWhere.push('context_space_id=?');
        summaryParams.push(contextSpaceId);
      }
      const compressionSummary = all(this.db, `SELECT * FROM messages WHERE ${summaryWhere.join(' AND ')}
        ORDER BY created_at DESC,id DESC`, summaryParams)
        .map((row) => this.getMessage(row.id))
        .find((message) => message?.metadata?.contextCompressionSummary
          && (!state || Number(message.metadata.contextEpoch || 0) === state.contextEpoch)) || null;
      const where = [identityWhere, 'visible=1'];
      const params = [identityValue];
      if (!includeAllContexts && contextSpaceId) {
        where.push('context_space_id=?');
        params.push(contextSpaceId);
      }
      if (state?.resetAfterCreatedAt) {
        where.push('(created_at>? OR (created_at=? AND id>?))');
        params.push(state.resetAfterCreatedAt, state.resetAfterCreatedAt, state.resetAfterMessageId || '');
      }
      const visibleMessages = all(this.db, `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at ASC,id ASC`, params)
        .map((row) => this.getMessage(row.id));
      return compressionSummary ? [compressionSummary, ...visibleMessages] : visibleMessages;
    },
  });
}

export function stableChatContextStateId(ownerUserId = '', sessionId = '', contextSpaceId = '') {
  const identity = `${String(ownerUserId || '').trim()}\n${String(sessionId || '').trim()}\n${String(contextSpaceId || '').trim()}`;
  return `chatctx_${sha256Text(identity).slice(0, 32)}`;
}

export function collisionSafeChatContextStateId(db, {
  ownerUserId = '', sessionId = '', contextSpaceId = '', preferredId = '',
} = {}) {
  const identity = normalizedChatContextIdentity({ ownerUserId, sessionId, contextSpaceId });
  const current = get(db, `SELECT * FROM chat_context_states
    WHERE owner_user_id=? AND session_id=? AND context_space_id=?`, [identity.ownerUserId, identity.sessionId, identity.contextSpaceId]);
  if (current?.id) return current.id;
  const stableId = stableChatContextStateId(identity.ownerUserId, identity.sessionId, identity.contextSpaceId);
  const candidates = [...new Set([String(preferredId || '').trim(), stableId].filter(Boolean))];
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    candidates.push(`chatctx_${sha256Text(`${identity.ownerUserId}\n${identity.sessionId}\n${identity.contextSpaceId}\ncollision:${attempt}`).slice(0, 32)}`);
  }
  for (const candidate of candidates) {
    const occupied = get(db, 'SELECT * FROM chat_context_states WHERE id=?', [candidate]);
    if (!occupied || sameChatContextIdentity(occupied, identity)) return candidate;
  }
  throw chatContextStateCollisionError({ ...identity, id: preferredId || stableId });
}

export function normalizeChatContextState(row) {
  if (!row) return null;
  return {
    id: row.id, ownerUserId: row.owner_user_id, sessionId: row.session_id,
    contextSpaceId: row.context_space_id || '', contextEpoch: Number(row.context_epoch || 1),
    resetAfterMessageId: row.reset_after_message_id || '', resetAfterCreatedAt: row.reset_after_created_at || '',
    lastExecutionId: row.last_execution_id || '', lastInputTokens: Number(row.last_input_tokens || 0),
    contextWindowTokens: Number(row.context_window_tokens || 0),
    providerCompactionDetected: Boolean(row.provider_compaction_detected), stateRevision: Number(row.state_revision || 1),
    baseStateRevision: Number(row.base_state_revision || 0), lastCommandId: row.last_command_id || '',
    sourceDeviceId: row.source_device_id || '', syncStatus: row.sync_status || 'pending',
    createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizedChatContextIdentity({ ownerUserId = '', sessionId = '', contextSpaceId = '' } = {}) {
  return {
    ownerUserId: String(ownerUserId || '').trim(),
    sessionId: String(sessionId || '').trim(),
    contextSpaceId: String(contextSpaceId || ''),
  };
}

function sameChatContextIdentity(row = {}, identity = {}) {
  return String(row.owner_user_id || '') === identity.ownerUserId
    && String(row.session_id || '') === identity.sessionId
    && String(row.context_space_id || '') === identity.contextSpaceId;
}

function chatContextStateCollisionError({ ownerUserId = '', sessionId = '', contextSpaceId = '', id = '' } = {}) {
  const error = new Error('Unable to allocate a collision-safe chat context state ID.');
  error.code = 'chat_context_state_identity_collision';
  error.details = { ownerUserId, sessionId, contextSpaceId, preferredId: id };
  return error;
}
