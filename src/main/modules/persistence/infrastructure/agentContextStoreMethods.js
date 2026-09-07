import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';

const CONTEXT_KINDS = new Set(['general_memory', 'project', 'task', 'relationship', 'legacy_history']);

export function installAgentContextStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureAgentContextSpace({
      userId = '', agentInstanceId = '', contextKind = 'general_memory', memoryDocumentId = '',
      projectId = '', taskRunId = '', delegationId = '', groupId = '', relationshipUserId = '',
      legacySessionId = '', lifecycleState = 'active', contextSpaceId = '', workspaceId = '',
    } = {}) {
      if (!userId || !agentInstanceId) throw new Error('Context space requires user and Agent instance.');
      if (!CONTEXT_KINDS.has(contextKind)) throw new Error('Invalid context space kind.');
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      const existing = get(this.db, `SELECT * FROM agent_context_spaces
        WHERE account_workspace_id=? AND user_agent_instance_id=? AND context_kind=? AND memory_document_id=? AND project_id=?
          AND task_run_id=? AND delegation_id=? AND group_id=? AND relationship_user_id=? AND legacy_session_id=?`, [
        resolvedWorkspaceId, agentInstanceId, contextKind, memoryDocumentId, projectId, taskRunId, delegationId, groupId, relationshipUserId, legacySessionId,
      ]);
      if (existing) return normalizeContextSpace(existing);
      const id = contextSpaceId || newId('ctx');
      const now = nowIso();
      run(this.db, `INSERT INTO agent_context_spaces (
        id,account_workspace_id,user_id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,
        delegation_id,group_id,relationship_user_id,legacy_session_id,lifecycle_state,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, resolvedWorkspaceId, userId, agentInstanceId, contextKind, memoryDocumentId, projectId, taskRunId,
        delegationId, groupId, relationshipUserId, legacySessionId, lifecycleState, now, now,
      ]);
      return normalizeContextSpace(get(this.db, 'SELECT * FROM agent_context_spaces WHERE id=?', [id]));
    },

    listAgentContextSpaces({ userId = '', agentInstanceId = '', workspaceId = '', includeArchived = true } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      const where = ['account_workspace_id=?', 'user_id=?', 'user_agent_instance_id=?'];
      const params = [resolvedWorkspaceId, userId, agentInstanceId];
      if (!includeArchived) where.push("lifecycle_state!='archived'");
      return all(this.db, `SELECT * FROM agent_context_spaces WHERE ${where.join(' AND ')}
        ORDER BY CASE context_kind WHEN 'general_memory' THEN 0 WHEN 'project' THEN 1 WHEN 'task' THEN 2 WHEN 'relationship' THEN 3 ELSE 9 END,
          updated_at DESC,id`, params).map(normalizeContextSpace);
    },

    getAgentContextSpace(contextSpaceId = '') {
      return normalizeContextSpace(get(this.db, 'SELECT * FROM agent_context_spaces WHERE id=?', [contextSpaceId]));
    },

    getPrimaryAgentSession({ userId = '', agentInstanceId = '', workspaceId = '' } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      return this.getSession(get(this.db, `SELECT id FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?
        AND conversation_role='primary' AND write_state='writable' AND status!='deleted'
        ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1`, [userId, resolvedWorkspaceId, agentInstanceId])?.id || '');
    },

    reconcileAgentPrimarySessionState({ userId = '', agentInstanceId = '', deviceId = 'local', workspaceId = '' } = {}) {
      if (!userId || !agentInstanceId) return null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId, deviceId }) || 'workspace_personal';
      const current = get(this.db, `SELECT * FROM agent_context_state
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId]);
      if (!current) return null;
      const primary = this.getPrimaryAgentSession({ userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const currentPrimary = current.primary_session_id ? this.getSession(current.primary_session_id) : null;
      const currentPrimaryValid = currentPrimary
        && currentPrimary.userId === userId
        && currentPrimary.accountWorkspaceId === resolvedWorkspaceId
        && currentPrimary.agentInstanceId === agentInstanceId
        && currentPrimary.conversationRole === 'primary'
        && currentPrimary.writeState === 'writable'
        && currentPrimary.status !== 'deleted';
      const resolvedPrimarySessionId = primary?.id || (currentPrimaryValid ? currentPrimary.id : '');
      if (resolvedPrimarySessionId === (current.primary_session_id || '')) return normalizeAccountContextState(current);
      const baseRevision = current.sync_status === 'synced'
        ? Number(current.state_revision || 1)
        : Number(current.base_state_revision || 0);
      const now = nowIso();
      run(this.db, `UPDATE agent_context_state SET primary_session_id=?,state_revision=state_revision+1,
        base_state_revision=?,last_command_id=?,source_device_id=?,sync_status='pending',updated_at=?
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
        resolvedPrimarySessionId, baseRevision, newId('context_primary_repair'), deviceId || 'local', now, userId, resolvedWorkspaceId, agentInstanceId,
      ]);
      run(this.db, `INSERT INTO agent_device_context_state(
        device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,updated_at
      ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,account_workspace_id,user_agent_instance_id) DO UPDATE SET
        user_id=excluded.user_id,primary_session_id=excluded.primary_session_id,
        active_context_space_id=excluded.active_context_space_id,active_memory_document_id=excluded.active_memory_document_id,
        updated_at=excluded.updated_at`, [
        deviceId || 'local', userId, resolvedWorkspaceId, agentInstanceId, resolvedPrimarySessionId,
        current.active_context_space_id || '', current.active_memory_document_id || '', now,
      ]);
      return {
        ...normalizeAccountContextState(get(this.db, `SELECT * FROM agent_context_state
          WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId])),
        reason: 'primary_session_repaired',
      };
    },

    listAgentSessionHistory({ userId = '', agentInstanceId = '', workspaceId = '' } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      return all(this.db, `SELECT * FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?
        AND conversation_role='history' AND status!='deleted' ORDER BY updated_at DESC,created_at DESC,id DESC`,
      [userId, resolvedWorkspaceId, agentInstanceId]).map((row) => this.getSession(row.id));
    },

    listAgentConversationHistoryGroups({
      userId = '', agentInstanceId = '', workspaceId = '', currentContextSpaceId = '', currentMemoryDocumentId = '',
    } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      const rows = agentConversationHistoryRows(this, { userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      return groupAgentConversationHistory(rows, { currentContextSpaceId, currentMemoryDocumentId });
    },

    getAgentConversationHistoryGroup({
      userId = '', agentInstanceId = '', workspaceId = '', historyGroupId = '', currentContextSpaceId = '', currentMemoryDocumentId = '',
    } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      const rows = agentConversationHistoryRows(this, { userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const groups = groupAgentConversationHistory(rows, { currentContextSpaceId, currentMemoryDocumentId });
      const group = groups.find((item) => item.id === String(historyGroupId || '').trim()) || null;
      if (!group) return null;
      const messages = rows.filter((row) => agentConversationHistoryGroupId(row) === group.id)
        .map((row) => this.getMessage(row.id)).filter(Boolean);
      return {
        group,
        messages,
        attachments: messages.flatMap((message) => this.listMessageAttachments?.(message.id) || []),
      };
    },

    ensureDeviceContextState({ deviceId = 'local', userId = '', agentInstanceId = '', workspaceId = '' } = {}) {
      if (!agentInstanceId) return null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId, deviceId }) || 'workspace_personal';
      const account = this.ensureAgentContextState({ userId, agentInstanceId, deviceId, workspaceId: resolvedWorkspaceId });
      const current = get(this.db, `SELECT * FROM agent_device_context_state
        WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [deviceId, resolvedWorkspaceId, agentInstanceId]);
      if (current) {
        if (account && (current.primary_session_id !== account.primarySessionId
          || current.active_context_space_id !== account.activeContextSpaceId
          || current.active_memory_document_id !== account.activeMemoryDocumentId)) {
          run(this.db, `UPDATE agent_device_context_state SET primary_session_id=?,active_context_space_id=?,
            active_memory_document_id=?,updated_at=? WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
            account.primarySessionId, account.activeContextSpaceId, account.activeMemoryDocumentId,
            account.updatedAt || nowIso(), deviceId, resolvedWorkspaceId, agentInstanceId,
          ]);
        }
        return normalizeDeviceContextState(get(this.db, `SELECT * FROM agent_device_context_state
          WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [deviceId, resolvedWorkspaceId, agentInstanceId]));
      }
      const primary = this.getPrimaryAgentSession({ userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const memory = get(this.db, `SELECT * FROM memory_documents WHERE account_workspace_id=? AND user_agent_instance_id=? AND scope='general'
        AND lifecycle_state='active' ORDER BY updated_at DESC,slot_no DESC,id DESC LIMIT 1`, [resolvedWorkspaceId, agentInstanceId]);
      let context = memory ? get(this.db, `SELECT * FROM agent_context_spaces WHERE account_workspace_id=? AND user_agent_instance_id=?
        AND context_kind='general_memory' AND memory_document_id=? LIMIT 1`, [resolvedWorkspaceId, agentInstanceId, memory.id]) : null;
      if (memory && !context) context = this.ensureAgentContextSpace({
        userId, agentInstanceId, workspaceId: resolvedWorkspaceId, contextKind: 'general_memory', memoryDocumentId: memory.id,
      });
      run(this.db, `INSERT INTO agent_device_context_state (
        device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)`, [deviceId, userId, resolvedWorkspaceId, agentInstanceId,
        account?.primarySessionId || primary?.id || '', account?.activeContextSpaceId || context?.id || '',
        account?.activeMemoryDocumentId || memory?.id || '', account?.updatedAt || nowIso()]);
      return normalizeDeviceContextState(get(this.db, `SELECT * FROM agent_device_context_state
        WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [deviceId, resolvedWorkspaceId, agentInstanceId]));
    },

    ensureAgentContextState({ userId = '', agentInstanceId = '', deviceId = 'local', workspaceId = '' } = {}) {
      if (!userId || !agentInstanceId) return null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId, deviceId }) || 'workspace_personal';
      this.ensureDefaultMemoryDocument?.({ agentInstanceId, workspaceId: resolvedWorkspaceId });
      const existing = get(this.db, `SELECT * FROM agent_context_state
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId]);
      if (existing) {
        this.reconcileAgentPrimarySessionState({ userId, agentInstanceId, deviceId, workspaceId: resolvedWorkspaceId });
        const current = get(this.db, `SELECT * FROM agent_context_state
          WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId]);
        return repairAgentMemoryContextState(this, {
          userId, agentInstanceId, deviceId, workspaceId: resolvedWorkspaceId, current,
        });
      }
      const primary = this.getPrimaryAgentSession({ userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const memory = get(this.db, `SELECT * FROM memory_documents WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
        AND scope='general' AND lifecycle_state='active' ORDER BY updated_at DESC,slot_no DESC,id DESC LIMIT 1`, [resolvedWorkspaceId, userId, agentInstanceId]);
      let context = memory ? get(this.db, `SELECT * FROM agent_context_spaces WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
        AND context_kind='general_memory' AND memory_document_id=? LIMIT 1`, [resolvedWorkspaceId, userId, agentInstanceId, memory.id]) : null;
      if (memory && !context) context = this.ensureAgentContextSpace({
        userId, agentInstanceId, workspaceId: resolvedWorkspaceId, contextKind: 'general_memory', memoryDocumentId: memory.id,
      });
      const now = nowIso();
      run(this.db, `INSERT INTO agent_context_state(
        user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,
        state_revision,base_state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,1,0,'context_state_created',?,'pending',?,?)`, [
        userId, resolvedWorkspaceId, agentInstanceId, primary?.id || '', context?.id || '', memory?.id || '', deviceId || 'local', now, now,
      ]);
      return normalizeAccountContextState(get(this.db, `SELECT * FROM agent_context_state
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId]));
    },

    getAgentContextState({ userId = '', agentInstanceId = '', deviceId = 'local', workspaceId = '' } = {}) {
      return this.ensureAgentContextState({ userId, agentInstanceId, deviceId, workspaceId });
    },

    stageAgentContextState({
      userId = '', agentInstanceId = '', deviceId = 'local', primarySessionId,
      activeContextSpaceId, activeMemoryDocumentId, commandId = '', reason = 'context_changed', workspaceId = '',
    } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId, deviceId }) || 'workspace_personal';
      const current = this.ensureAgentContextState({ userId, agentInstanceId, deviceId, workspaceId: resolvedWorkspaceId });
      if (!current) return null;
      const nextPrimary = primarySessionId === undefined ? current.primarySessionId : String(primarySessionId || '');
      const nextContext = activeContextSpaceId === undefined ? current.activeContextSpaceId : String(activeContextSpaceId || '');
      const nextMemory = activeMemoryDocumentId === undefined ? current.activeMemoryDocumentId : String(activeMemoryDocumentId || '');
      if (nextPrimary === current.primarySessionId && nextContext === current.activeContextSpaceId
        && nextMemory === current.activeMemoryDocumentId && current.syncStatus === 'pending') return current;
      const baseRevision = current.syncStatus === 'synced' ? current.stateRevision : current.baseStateRevision;
      const now = nowIso();
      run(this.db, `UPDATE agent_context_state SET primary_session_id=?,active_context_space_id=?,active_memory_document_id=?,
        state_revision=state_revision+1,base_state_revision=?,last_command_id=?,source_device_id=?,sync_status='pending',updated_at=?
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
        nextPrimary, nextContext, nextMemory, baseRevision, commandId || newId('context_command'), deviceId || 'local', now, userId, resolvedWorkspaceId, agentInstanceId,
      ]);
      run(this.db, `INSERT INTO agent_device_context_state(
        device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,updated_at
      ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,account_workspace_id,user_agent_instance_id) DO UPDATE SET
        user_id=excluded.user_id,primary_session_id=excluded.primary_session_id,
        active_context_space_id=excluded.active_context_space_id,active_memory_document_id=excluded.active_memory_document_id,
        updated_at=excluded.updated_at`, [deviceId, userId, resolvedWorkspaceId, agentInstanceId, nextPrimary, nextContext, nextMemory, now]);
      return { ...normalizeAccountContextState(get(this.db, `SELECT * FROM agent_context_state
        WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId])), reason };
    },

    getDeviceContextState({ deviceId = 'local', userId = '', agentInstanceId = '', workspaceId = '' } = {}) {
      return this.ensureDeviceContextState({ deviceId, userId, agentInstanceId, workspaceId });
    },

    getAgentConversationContextSpace({ deviceId = 'local', userId = '', agentInstanceId = '', workspaceId = '' } = {}) {
      if (!userId || !agentInstanceId) return null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId, deviceId }) || 'workspace_personal';
      const state = this.ensureDeviceContextState({ deviceId, userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const memoryDocumentId = state?.activeMemoryDocumentId || get(this.db, `SELECT id FROM memory_documents
        WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state='active'
        ORDER BY updated_at DESC,slot_no DESC,id DESC LIMIT 1`, [resolvedWorkspaceId, userId, agentInstanceId])?.id || '';
      if (!memoryDocumentId) return null;
      const existing = get(this.db, `SELECT * FROM agent_context_spaces
        WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND context_kind='general_memory' AND memory_document_id=?
        LIMIT 1`, [resolvedWorkspaceId, userId, agentInstanceId, memoryDocumentId]);
      return existing ? normalizeContextSpace(existing) : this.ensureAgentContextSpace({
        userId, agentInstanceId, workspaceId: resolvedWorkspaceId, contextKind: 'general_memory', memoryDocumentId,
      });
    },

    switchAgentContext({
      deviceId = 'local', userId = '', agentInstanceId = '', contextSpaceId = '', reason = 'user_switch', workspaceId = '',
      expectedStateRevision, expectedActiveContextSpaceId, expectedActiveMemoryDocumentId, withinTransaction = false,
    } = {}) {
      const context = this.getAgentContextSpace(contextSpaceId);
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId, deviceId }) || 'workspace_personal';
      if (!context || context.workspaceId !== resolvedWorkspaceId || context.userId !== userId || context.userAgentInstanceId !== agentInstanceId) throw new Error('Context space ownership mismatch.');
      if (context.lifecycleState === 'archived' || context.contextKind === 'legacy_history') throw new Error('Read-only context space cannot become current.');
      const state = this.ensureDeviceContextState({ deviceId, userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const memoryDocumentId = context.contextKind === 'general_memory'
        ? context.memoryDocumentId
        : state?.activeMemoryDocumentId || '';
      const primary = this.getPrimaryAgentSession({ userId, agentInstanceId, workspaceId: resolvedWorkspaceId });
      const ownsTransaction = !withinTransaction && !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        if (expectedStateRevision !== undefined && expectedStateRevision !== null) {
          const accountState = get(this.db, `SELECT state_revision,active_context_space_id,active_memory_document_id FROM agent_context_state
            WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, resolvedWorkspaceId, agentInstanceId]);
          const revisionChanged = Number(accountState?.state_revision || 0) !== Number(expectedStateRevision);
          const hasExpectedSelection = expectedActiveContextSpaceId !== undefined
            || expectedActiveMemoryDocumentId !== undefined;
          const expectedSelectionStillCurrent = hasExpectedSelection
            && (expectedActiveContextSpaceId === undefined
              || String(accountState?.active_context_space_id || '') === String(expectedActiveContextSpaceId || ''))
            && (expectedActiveMemoryDocumentId === undefined
              || String(accountState?.active_memory_document_id || '') === String(expectedActiveMemoryDocumentId || ''));
          if (revisionChanged && !expectedSelectionStillCurrent) {
            const error = new Error('Memory 上下文已在其他设备发生变化，请刷新后重试。');
            error.code = 'memory_context_state_conflict';
            error.details = {
              expectedStateRevision: Number(expectedStateRevision),
              currentStateRevision: Number(accountState?.state_revision || 0),
              currentActiveContextSpaceId: accountState?.active_context_space_id || '',
              currentActiveMemoryDocumentId: accountState?.active_memory_document_id || '',
            };
            throw error;
          }
        }
        if (context.contextKind === 'general_memory' && context.memoryDocumentId) {
          const switchedAt=nowIso();
          run(this.db,"UPDATE memory_documents SET lifecycle_state='inactive' WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state='active' AND id<>?",[resolvedWorkspaceId,userId,agentInstanceId,context.memoryDocumentId]);
          run(this.db,"UPDATE memory_documents SET lifecycle_state='active',updated_at=? WHERE id=?",[switchedAt,context.memoryDocumentId]);
          run(this.db,"UPDATE agent_context_spaces SET lifecycle_state='inactive' WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND context_kind='general_memory' AND lifecycle_state='active' AND memory_document_id<>?",[resolvedWorkspaceId,userId,agentInstanceId,context.memoryDocumentId]);
          run(this.db,"UPDATE agent_context_spaces SET lifecycle_state='active',updated_at=? WHERE memory_document_id=?",[switchedAt,context.memoryDocumentId]);
        }
        run(this.db, `UPDATE agent_device_context_state SET primary_session_id=?,active_context_space_id=?,
          active_memory_document_id=?,updated_at=? WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
          primary?.id || '', context.id, memoryDocumentId, nowIso(),userId,resolvedWorkspaceId,agentInstanceId,
        ]);
        if (primary) run(this.db, "UPDATE sessions SET codex_thread_id='',updated_at=? WHERE id=?", [nowIso(), primary.id]);
        this.stageAgentContextState({
          userId, agentInstanceId, deviceId, primarySessionId: primary?.id || '', activeContextSpaceId: context.id,
          activeMemoryDocumentId: memoryDocumentId, reason, workspaceId: resolvedWorkspaceId,
        });
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return { context, state: normalizeDeviceContextState(get(this.db, `SELECT * FROM agent_device_context_state
        WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [deviceId, resolvedWorkspaceId, agentInstanceId])), threadReset: Boolean(primary), reason };
    },

    ensureMemorySyncMapping({ deviceId = 'local', memoryDocumentId = '', privateKey = '', cloudKey = '' } = {}) {
      const document = get(this.db, 'SELECT * FROM memory_documents WHERE id=?', [memoryDocumentId]);
      if (!document) throw new Error('Memory document not found.');
      const existing = get(this.db, 'SELECT * FROM memory_sync_mappings WHERE device_id=? AND memory_document_id=?', [deviceId, memoryDocumentId]);
      if (existing) return normalizeMemoryMapping(existing);
      const resolvedPrivateKey = privateKey || newId('memory_private');
      const resolvedCloudKey = cloudKey || document.cloud_key || document.id || newId('memory_cloud');
      const now = nowIso();
      run(this.db, `INSERT INTO memory_sync_mappings (
        device_id,private_key,cloud_key,owner_user_id,user_agent_instance_id,memory_document_id,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?, 'active',?,?)`, [
        deviceId, resolvedPrivateKey, resolvedCloudKey, document.user_id, document.user_agent_instance_id, document.id, now, now,
      ]);
      if (!document.cloud_key) run(this.db, 'UPDATE memory_documents SET cloud_key=?,updated_at=? WHERE id=?', [resolvedCloudKey, now, document.id]);
      return normalizeMemoryMapping(get(this.db, 'SELECT * FROM memory_sync_mappings WHERE device_id=? AND memory_document_id=?', [deviceId, memoryDocumentId]));
    },

    memorySyncMapping({ deviceId = 'local', memoryDocumentId = '' } = {}) {
      const existing = get(this.db, 'SELECT * FROM memory_sync_mappings WHERE device_id=? AND memory_document_id=?', [deviceId, memoryDocumentId]);
      return existing ? normalizeMemoryMapping(existing) : this.ensureMemorySyncMapping({ deviceId, memoryDocumentId });
    },

    recordMemoryAccessAudit(input = {}) {
      const id = input.id || newId('memory_audit');
      run(this.db, `INSERT INTO memory_access_audits (
        id,requester_user_id,requester_agent_instance_id,target_user_id,target_agent_instance_id,
        context_space_id,task_run_id,memory_document_id,memory_cloud_key,memory_document_version_id,
        action,requested_reason,result,result_code,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, input.requesterUserId || '', input.requesterAgentInstanceId || '', input.targetUserId || '', input.targetAgentInstanceId || '',
        input.contextSpaceId || '', input.taskRunId || '', input.memoryDocumentId || '', input.memoryCloudKey || '',
        input.memoryDocumentVersionId || '', input.action || 'read', input.reason || '', input.result || 'allowed', input.resultCode || '', nowIso(),
      ]);
      return get(this.db, 'SELECT * FROM memory_access_audits WHERE id=?', [id]);
    },

    listMemoryAccessAudits({ userId = '', agentInstanceId = '', limit = 200 } = {}) {
      return all(this.db, `SELECT * FROM memory_access_audits WHERE target_user_id=?
        AND (?='' OR target_agent_instance_id=?) ORDER BY created_at DESC,id DESC LIMIT ?`, [
        userId, agentInstanceId, agentInstanceId, Math.max(1, Math.min(500, Number(limit || 200))),
      ]);
    },
  });
}

function agentConversationHistoryRows(store, { userId = '', agentInstanceId = '', workspaceId = 'workspace_personal' } = {}) {
  if (!userId || !agentInstanceId) return [];
  return all(store.db, `SELECT message.id,message.session_id,message.memory_id,message.context_space_id,
      message.content,message.created_at,session.title AS session_title,
      context.context_kind,context.memory_document_id AS context_memory_document_id,
      context.project_id AS context_project_id,context.task_run_id AS context_task_run_id,
      context.legacy_session_id,context.lifecycle_state AS context_lifecycle_state,
      memory.id AS memory_document_id,memory.display_name AS memory_display_name,memory.scope AS memory_scope,
      memory.lifecycle_state AS memory_lifecycle_state,memory.project_id AS memory_project_id,
      memory.task_run_id AS memory_task_run_id,project.title AS project_title,task.title AS task_title
    FROM messages message
    JOIN sessions session ON session.id=message.session_id
    LEFT JOIN agent_context_spaces context ON context.id=message.context_space_id
    LEFT JOIN memory_documents memory ON memory.id=COALESCE(NULLIF(message.memory_id,''),NULLIF(context.memory_document_id,''))
    LEFT JOIN projects project ON project.id=COALESCE(NULLIF(context.project_id,''),NULLIF(memory.project_id,''))
    LEFT JOIN task_runs task ON task.id=COALESCE(NULLIF(context.task_run_id,''),NULLIF(memory.task_run_id,''),NULLIF(message.task_run_id,''))
    WHERE session.user_id=? AND session.account_workspace_id=? AND session.status!='deleted'
      AND message.account_workspace_id=? AND message.visible=1
      AND (message.agent_instance_id=? OR (message.agent_instance_id='' AND session.agent_instance_id=?))
    ORDER BY message.created_at,message.id`, [userId, workspaceId, workspaceId, agentInstanceId, agentInstanceId]);
}

function agentConversationHistoryGroupId(row = {}) {
  const contextSpaceId = String(row.context_space_id || '').trim();
  if (contextSpaceId) return `context:${contextSpaceId}`;
  const memoryDocumentId = String(row.memory_id || row.memory_document_id || '').trim();
  if (memoryDocumentId) return `memory:${memoryDocumentId}`;
  const sessionId = String(row.session_id || '').trim();
  return sessionId ? `session:${sessionId}` : '';
}

function groupAgentConversationHistory(rows = [], { currentContextSpaceId = '', currentMemoryDocumentId = '' } = {}) {
  const currentContext = String(currentContextSpaceId || '').trim();
  const currentMemory = String(currentMemoryDocumentId || '').trim();
  const groups = new Map();
  for (const row of rows) {
    const contextSpaceId = String(row.context_space_id || '').trim();
    const memoryDocumentId = String(row.memory_id || row.memory_document_id || '').trim();
    if ((currentContext && contextSpaceId === currentContext)
      || (!contextSpaceId && currentMemory && memoryDocumentId === currentMemory)) continue;
    const id = agentConversationHistoryGroupId(row);
    if (!id) continue;
    const contextKind = String(row.context_kind || '').trim();
    const memoryScope = String(row.memory_scope || '').trim();
    const kind = contextKind === 'legacy_history'
      ? 'legacy'
      : contextKind === 'project' || memoryScope === 'project'
      ? 'project'
      : contextKind === 'task' || memoryScope === 'task'
        ? 'task'
        : contextSpaceId || memoryDocumentId ? 'memory' : 'legacy';
    const projectId = row.context_project_id || row.memory_project_id || '';
    const taskRunId = row.context_task_run_id || row.memory_task_run_id || '';
    const title = kind === 'project'
      ? row.project_title || row.memory_display_name || row.session_title || '项目对话'
      : kind === 'task'
        ? row.task_title || row.memory_display_name || row.session_title || '任务对话'
        : kind === 'memory'
          ? row.memory_display_name || row.session_title || '历史 Memory'
          : row.session_title || '旧会话';
    const existing = groups.get(id) || {
      id,
      kind,
      title,
      summary: '',
      messageCount: 0,
      lastMessageAt: '',
      contextSpaceId,
      memoryDocumentId,
      sessionId: row.session_id || '',
      projectId,
      taskRunId,
      lifecycleState: row.memory_lifecycle_state || row.context_lifecycle_state || 'inactive',
      readOnly: true,
    };
    existing.messageCount += 1;
    existing.sessionId = row.session_id || existing.sessionId;
    existing.lastMessageAt = row.created_at || existing.lastMessageAt;
    const summary = summarizeHistoryMessage(row.content);
    if (summary) existing.summary = summary;
    groups.set(id, existing);
  }
  return [...groups.values()].sort((left, right) => (
    String(right.lastMessageAt || '').localeCompare(String(left.lastMessageAt || '')) || left.id.localeCompare(right.id)
  ));
}

function summarizeHistoryMessage(value = '') {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, 120).join('');
}

function normalizeContextSpace(row) {
  if (!row) return null;
  return {
    id: row.id, accountWorkspaceId: row.account_workspace_id || 'workspace_personal', workspaceId: row.account_workspace_id || 'workspace_personal',
    userId: row.user_id, userAgentInstanceId: row.user_agent_instance_id,
    contextKind: row.context_kind, memoryDocumentId: row.memory_document_id || '', projectId: row.project_id || '',
    taskRunId: row.task_run_id || '', delegationId: row.delegation_id || '', groupId: row.group_id || '',
    relationshipUserId: row.relationship_user_id || '', legacySessionId: row.legacy_session_id || '',
    lifecycleState: row.lifecycle_state || 'active', createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeDeviceContextState(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id, userId: row.user_id, accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal', userAgentInstanceId: row.user_agent_instance_id,
    primarySessionId: row.primary_session_id || '', activeContextSpaceId: row.active_context_space_id || '',
    activeMemoryDocumentId: row.active_memory_document_id || '', updatedAt: row.updated_at,
  };
}

function normalizeAccountContextState(row) {
  if (!row) return null;
  return {
    userId: row.user_id, accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal', userAgentInstanceId: row.user_agent_instance_id,
    primarySessionId: row.primary_session_id || '', activeContextSpaceId: row.active_context_space_id || '',
    activeMemoryDocumentId: row.active_memory_document_id || '', stateRevision: Number(row.state_revision || 1),
    baseStateRevision: Number(row.base_state_revision || 0), lastCommandId: row.last_command_id || '',
    sourceDeviceId: row.source_device_id || '', syncStatus: row.sync_status || 'pending',
    createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}

function repairAgentMemoryContextState(store, {
  userId = '', agentInstanceId = '', deviceId = 'local', workspaceId = 'workspace_personal', current = null,
} = {}) {
  if (!current) return null;
  let memory = current.active_memory_document_id ? get(store.db, `SELECT * FROM memory_documents
    WHERE id=? AND account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
      AND scope='general' AND lifecycle_state='active'`, [
    current.active_memory_document_id, workspaceId, userId, agentInstanceId,
  ]) : null;
  let context = current.active_context_space_id ? get(store.db, `SELECT * FROM agent_context_spaces
    WHERE id=? AND account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND lifecycle_state!='archived'`, [
    current.active_context_space_id, workspaceId, userId, agentInstanceId,
  ]) : null;
  if (!memory && context?.context_kind === 'general_memory' && context.memory_document_id) {
    memory = get(store.db, `SELECT * FROM memory_documents
      WHERE id=? AND account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
        AND scope='general' AND lifecycle_state='active'`, [
      context.memory_document_id, workspaceId, userId, agentInstanceId,
    ]);
  }
  if (!memory) {
    memory = get(store.db, `SELECT * FROM memory_documents
      WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
        AND scope='general' AND lifecycle_state='active'
      ORDER BY updated_at DESC,slot_no DESC,id DESC LIMIT 1`, [workspaceId, userId, agentInstanceId]);
  }
  if (context?.context_kind === 'general_memory' && context.memory_document_id !== (memory?.id || '')) context = null;
  if (!context && memory) {
    context = get(store.db, `SELECT * FROM agent_context_spaces
      WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
        AND context_kind='general_memory' AND memory_document_id=? AND lifecycle_state!='archived'
      LIMIT 1`, [workspaceId, userId, agentInstanceId, memory.id]);
    if (!context) {
      const ensured = store.ensureAgentContextSpace({
        userId, agentInstanceId, workspaceId, contextKind: 'general_memory', memoryDocumentId: memory.id,
      });
      if (ensured?.lifecycleState !== 'archived') context = get(store.db, 'SELECT * FROM agent_context_spaces WHERE id=?', [ensured.id]);
    }
  }
  const nextMemoryId = memory?.id || '';
  const nextContextId = context?.id || '';
  if (nextMemoryId === (current.active_memory_document_id || '')
    && nextContextId === (current.active_context_space_id || '')) return normalizeAccountContextState(current);
  const baseRevision = current.sync_status === 'synced'
    ? Number(current.state_revision || 1)
    : Number(current.base_state_revision || 0);
  const now = nowIso();
  const ownsTransaction = !store.db.isTransaction;
  if (ownsTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    run(store.db, `UPDATE agent_context_state SET active_context_space_id=?,active_memory_document_id=?,
      state_revision=state_revision+1,base_state_revision=?,last_command_id=?,source_device_id=?,sync_status='pending',updated_at=?
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
      nextContextId, nextMemoryId, baseRevision, newId('context_memory_repair'), deviceId || 'local', now,
      userId, workspaceId, agentInstanceId,
    ]);
    run(store.db, `INSERT INTO agent_device_context_state(
      device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,updated_at
    ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id,account_workspace_id,user_agent_instance_id) DO UPDATE SET
      user_id=excluded.user_id,primary_session_id=excluded.primary_session_id,
      active_context_space_id=excluded.active_context_space_id,active_memory_document_id=excluded.active_memory_document_id,
      updated_at=excluded.updated_at`, [
      deviceId || 'local', userId, workspaceId, agentInstanceId, current.primary_session_id || '', nextContextId, nextMemoryId, now,
    ]);
    if (ownsTransaction) store.db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
  return normalizeAccountContextState(get(store.db, `SELECT * FROM agent_context_state
    WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, workspaceId, agentInstanceId]));
}

function normalizeMemoryMapping(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id, privateKey: row.private_key, cloudKey: row.cloud_key,
    ownerUserId: row.owner_user_id, userAgentInstanceId: row.user_agent_instance_id,
    memoryDocumentId: row.memory_document_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
