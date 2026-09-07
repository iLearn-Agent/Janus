import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse, sha256Text } from '../../../utils.js';
import {
  cloudTaskMemoryPublicKeyringFromEnv,
  decryptTaskMemoryContent,
  encryptTaskMemoryContent,
  wrapTaskKeyForCloud,
} from '../../../../shared/taskMemoryCrypto.js';
import { recordMemoryVersionEvidenceOutbox } from './evolutionEvidenceOutboxStoreMethods.js';

const MEMORY_SCOPES = new Set(['general', 'task', 'project', 'relationship']);

export function installMemoryContextStoreMethods(prototype) {
  Object.assign(prototype, {
    createMemoryDocument({
      agentInstanceId = '',
      scope = 'general',
      slotNo,
      displayName = '',
      taskRunId = '',
      projectId = '',
      relationshipId = '',
      delegationId = '',
      groupId = '',
      relationshipUserId = '',
      contextSpaceId = '',
      content = '',
      sourceKind = 'user_created',
      sourceId = '',
      syncEnabled = true,
      allowPersonalEvolution,
      allowClusterEvolution,
      encryptionKeyId = '',
      consentScope = {},
      deviceId = '',
      workspaceId = '',
      withinTransaction = false,
    } = {}) {
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const normalizedScope = normalizeMemoryScope(scope);
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: instance.userId, workspaceId }) || 'workspace_personal';
      assertScopeIdentity(normalizedScope, { taskRunId, projectId, relationshipId });
      const resolvedSlotNo = resolveSlotNo(this.db, resolvedWorkspaceId, instance.id, normalizedScope, slotNo, { taskRunId, projectId, relationshipId });
      const existing = findScopedDocument(this.db, resolvedWorkspaceId, instance.id, normalizedScope, resolvedSlotNo, { taskRunId, projectId, relationshipId });
      if (existing) return this.getMemoryDocument(existing.id);
      const documentId = newId('memdoc');
      const versionId = newId('memdocver');
      const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
      const cloudKey = newId('memory_cloud');
      const now = nowIso();
      const effectivePersonalEvolution = allowPersonalEvolution === undefined
        ? Boolean(instance.personalEvolutionConsent)
        : Boolean(allowPersonalEvolution);
      const effectiveClusterEvolution = Boolean(instance.syncEnabled && instance.status === 'active');
      const name = normalizeMemoryDisplayName(displayName, defaultMemoryName(normalizedScope, resolvedSlotNo, { taskRunId, projectId, relationshipId }));
      const initialContent = String(content || emptyMemoryContent(name, normalizedScope));
      const protectedContent = protectMemoryContent(this, {
        scope: normalizedScope, taskRunId, documentId, versionNo: 1, content: initialContent,
      });
      const ownsTransaction = !withinTransaction && !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `INSERT INTO memory_documents (
          id,account_workspace_id,user_id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,task_run_id,project_id,
          relationship_id,delegation_id,group_id,relationship_user_id,context_space_id,work_scope_id,lifecycle_state,visibility,sync_enabled,
          allow_personal_evolution,allow_cluster_evolution,source_conversation_cursor,
          encryption_key_id,consent_scope_json,current_version_id,content_hash,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          documentId, resolvedWorkspaceId, instance.userId, instance.id, instance.agentFamilyId || '', cloudKey, normalizedScope, resolvedSlotNo, name,
          taskRunId || '', projectId || '', relationshipId || '', delegationId || '', groupId || '', relationshipUserId || '', contextSpaceId || '',
          normalizedScope === 'task' ? `task:${taskRunId}` : '',
          'active', 'agent_private', syncEnabled ? 1 : 0, effectivePersonalEvolution ? 1 : 0, effectiveClusterEvolution ? 1 : 0,
          '', encryptionKeyId || '', JSON.stringify(consentScope || {}), versionId,
          sha256Text(initialContent), now, now,
        ]);
        run(this.db, `INSERT INTO memory_document_versions (
          id,memory_document_id,version_no,content,content_hash,source_kind,source_id,
          privacy_level,review_status,created_by,origin_document_id,origin_version_no,
          base_version_id,parent_version_id,branch_id,conflict_state,
          encryption_algorithm,encryption_key_id,encryption_key_version,content_ciphertext,
          content_nonce,content_tag,content_aad,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          versionId, documentId, 1, protectedContent.content, sha256Text(initialContent), sourceKind || 'user_created',
          sourceId || '', 'private', 'seeded', instance.userId, documentId, 1, '', '', 'main', 'none',
          protectedContent.algorithm, protectedContent.keyId,
          protectedContent.keyVersion, protectedContent.ciphertext, protectedContent.nonce,
          protectedContent.tag, protectedContent.aad, now,
        ]);
        const contextKind = normalizedScope === 'general' ? 'general_memory' : normalizedScope;
        const context = this.ensureAgentContextSpace?.({
          userId: instance.userId, agentInstanceId: instance.id, contextKind,
          memoryDocumentId: normalizedScope === 'general' ? documentId : '', projectId: projectId || '', taskRunId: taskRunId || '',
          delegationId: delegationId || '', groupId: groupId || '', relationshipUserId: relationshipUserId || relationshipId || '',
          contextSpaceId: contextSpaceId || '', workspaceId: resolvedWorkspaceId,
        });
        if (context && !contextSpaceId) run(this.db, 'UPDATE memory_documents SET context_space_id=? WHERE id=?', [context.id, documentId]);
        this.ensureMemorySyncMapping?.({ deviceId: resolvedDeviceId, memoryDocumentId: documentId, cloudKey });
        recordMemoryVersionEvidenceOutbox(this, { documentId, versionId });
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getMemoryDocument(documentId);
    },

    createNextGeneralMemoryDocument({ agentInstanceId = '', displayName = '', content = '', deviceId = '', workspaceId = '' } = {}) {
      return this.createAndActivateGeneralMemory({ agentInstanceId, displayName, content, deviceId, workspaceId });
    },

    createAndActivateGeneralMemory({ agentInstanceId = '', displayName = '', content = '', deviceId = '', workspaceId = '' } = {}) {
      const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: instance.userId, workspaceId }) || 'workspace_personal';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, "UPDATE memory_documents SET lifecycle_state='inactive',updated_at=? WHERE account_workspace_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state='active'", [nowIso(), resolvedWorkspaceId, instance.id]);
        const document = this.createMemoryDocument({ agentInstanceId: instance.id, scope: 'general', displayName, content, sourceKind: 'user_created', deviceId: resolvedDeviceId, workspaceId: resolvedWorkspaceId, withinTransaction: true });
        const context = this.getAgentContextSpace(document.contextSpaceId) || this.ensureAgentContextSpace({
          userId: instance.userId, agentInstanceId: instance.id, contextKind: 'general_memory', memoryDocumentId: document.id, workspaceId: resolvedWorkspaceId,
        });
        const primary = this.getPrimaryAgentSession?.({ userId: instance.userId, agentInstanceId: instance.id, workspaceId: resolvedWorkspaceId });
        this.ensureDeviceContextState?.({ deviceId: resolvedDeviceId, userId: instance.userId, agentInstanceId: instance.id, workspaceId: resolvedWorkspaceId });
        run(this.db, `UPDATE agent_device_context_state SET primary_session_id=?,active_context_space_id=?,active_memory_document_id=?,updated_at=?
          WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [primary?.id || '',context.id,document.id,nowIso(),instance.userId,resolvedWorkspaceId,instance.id]);
        this.stageAgentContextState?.({
          userId: instance.userId, agentInstanceId: instance.id, deviceId: resolvedDeviceId,
          primarySessionId: primary?.id || '', activeContextSpaceId: context.id, activeMemoryDocumentId: document.id,
          reason: 'memory_created', workspaceId: resolvedWorkspaceId,
        });
        this.db.exec('COMMIT');
        return this.getMemoryDocument(document.id);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    ensureTaskMemoryDocument({
      agentInstanceId = '', taskRunId = '', taskTitle = '', delegationId = '', groupId = '',
      cloudEvolutionAllowed = false, workspaceId = '',
    } = {}) {
      if (!taskRunId) throw new Error('Task Memory requires taskRunId.');
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const task = this.getTaskRun?.(taskRunId) || null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: instance.userId, workspaceId: workspaceId || task?.accountWorkspaceId }) || 'workspace_personal';
      const security = this.ensureTaskSecurityContext({ taskRunId, ownerUserId: instance.userId, cloudEvolutionAllowed });
      const document = this.createMemoryDocument({
        agentInstanceId,
        scope: 'task',
        slotNo: 0,
        taskRunId,
        delegationId,
        groupId,
        displayName: taskTitle ? `${String(taskTitle).slice(0, 48)}.md` : `task-${taskRunId}.md`,
        content: `# ${taskTitle || `Task ${taskRunId}`}\n\n## Task Context\n- task_run_id: ${taskRunId}\n\n## Decisions\n\n## Collaboration Notes\n\n## Failure Modes\n\n## Reusable Candidates\n`,
        sourceKind: 'task_assigned',
        sourceId: taskRunId,
        allowPersonalEvolution: Boolean(instance.personalEvolutionConsent),
        allowClusterEvolution: Boolean(instance.syncEnabled && instance.status === 'active'),
        encryptionKeyId: security.localKeyId,
        consentScope: { taskProcessing: true, cloudEvolution: Boolean(cloudEvolutionAllowed) },
        workspaceId: resolvedWorkspaceId,
      });
      const nextDelegationId = String(delegationId || document.delegationId || '').trim();
      const nextGroupId = String(groupId || document.groupId || '').trim();
      const nextDisplayName = taskTitle ? `${String(taskTitle).slice(0, 48)}.md` : document.displayName;
      if (nextDelegationId !== document.delegationId || nextGroupId !== document.groupId || nextDisplayName !== document.displayName) {
        run(this.db, `UPDATE memory_documents SET delegation_id=?,group_id=?,display_name=?,updated_at=? WHERE id=?`, [
          nextDelegationId, nextGroupId, nextDisplayName, nowIso(), document.id,
        ]);
        if (document.contextSpaceId) {
          run(this.db, `UPDATE agent_context_spaces SET delegation_id=?,group_id=?,updated_at=? WHERE id=?`, [
            nextDelegationId, nextGroupId, nowIso(), document.contextSpaceId,
          ]);
        }
      }
      return this.getMemoryDocument(document.id);
    },

    canonicalizeDelegationTaskMemories({
      userId = '', delegationId = '', taskRunId = '', groupId = '', taskTitle = '',
    } = {}) {
      const provisionalTaskId = String(delegationId || '').trim();
      const canonicalTaskId = String(taskRunId || '').trim();
      if (!userId || !provisionalTaskId || !canonicalTaskId || provisionalTaskId === canonicalTaskId) return [];
      const provisionalDocuments = this.listMemoryDocuments({ userId }).filter((document) => (
        document.scope === 'task'
        && document.taskRunId === provisionalTaskId
        && document.lifecycleState !== 'archived'
      ));
      const mappings = [];
      for (const provisional of provisionalDocuments) {
        const canonical = this.ensureTaskMemoryDocument({
          agentInstanceId: provisional.userAgentInstanceId,
          taskRunId: canonicalTaskId,
          taskTitle: taskTitle || provisional.displayName?.replace(/\.md$/i, '') || '',
          delegationId: provisionalTaskId,
          groupId: groupId || provisional.groupId || '',
          cloudEvolutionAllowed: Boolean(provisional.allowClusterEvolution),
          workspaceId: provisional.workspaceId,
        });
        const marker = `<!-- canonicalized-from:${provisional.id} -->`;
        if (provisional.content && !String(canonical.content || '').includes(marker)) {
          const imported = delegationTaskMemoryHistory(provisional.content);
          if (imported) {
            this.appendMemoryDocumentVersion({
              memoryDocumentId: canonical.id,
              content: `${String(canonical.content || '').trimEnd()}\n\n## Imported Delegation Coordination History\n${marker}\n${imported}\n`,
              sourceKind: 'task_memory_canonicalized',
              sourceId: provisional.id,
              reviewStatus: 'task_local',
              createdBy: userId,
            });
          }
        }
        run(this.db, "UPDATE memory_documents SET lifecycle_state='archived',updated_at=? WHERE id=?", [nowIso(), provisional.id]);
        run(this.db, "UPDATE agent_context_spaces SET lifecycle_state='archived',updated_at=? WHERE memory_document_id=?", [nowIso(), provisional.id]);
        run(this.db, `INSERT OR REPLACE INTO memory_document_aliases (
          alias_document_id,canonical_document_id,user_id,reason,created_at
        ) VALUES (?,?,?,?,?)`, [provisional.id, canonical.id, userId, 'delegation_task_id_canonicalized', nowIso()]);
        for (const row of all(this.db, `SELECT outbox_id FROM evolution_evidence_outbox
          WHERE source_id=? AND status IN ('pending','claimed','deferred','failed_retryable')`, [provisional.id])) {
          this.completeEvolutionEvidenceOutbox?.(row.outbox_id, {
            status: 'quarantined',
            error: `canonical_task_memory_superseded:${canonical.id}`,
          });
        }
        mappings.push({ provisional: provisional.id, canonical: canonical.id, taskRunId: canonicalTaskId });
      }
      this.canonicalizeDelegationEvidenceOutbox?.({
        delegationId: provisionalTaskId,
        provisionalTaskRunId: provisionalTaskId,
        taskRunId: canonicalTaskId,
      });
      return mappings;
    },

    ensureRelationshipMemoryDocument({ agentInstanceId = '', relationshipId = '', displayName = '', workspaceId = '' } = {}) {
      if (!relationshipId) throw new Error('Relationship Memory requires relationshipId.');
      return this.createMemoryDocument({
        agentInstanceId,
        scope: 'relationship',
        slotNo: 0,
        relationshipId,
        relationshipUserId: relationshipId,
        displayName: displayName || `relationship-${relationshipId}.md`,
        sourceKind: 'relationship_created',
        sourceId: relationshipId,
        workspaceId,
      });
    },

    appendTaskMemoryObservation({
      agentInstanceId = '',
      taskRunId = '',
      taskTitle = '',
      sourceId = '',
      status = '',
      summary = '',
    } = {}) {
      if (!agentInstanceId || !taskRunId || !String(summary || '').trim()) return null;
      const document = this.ensureTaskMemoryDocument({ agentInstanceId, taskRunId, taskTitle });
      const line = `- ${nowIso()} [${status || 'update'}] ${String(summary).trim().slice(0, 2400)}`;
      const marker = '\n## Task Updates\n';
      const current = String(document.content || '');
      const next = current.includes(marker)
        ? `${current.trimEnd()}\n${line}\n`
        : `${current.trimEnd()}${marker}${line}\n`;
      return this.appendMemoryDocumentVersion({
        memoryDocumentId: document.id,
        content: next.slice(-24000),
        sourceKind: 'task_observation',
        sourceId: sourceId || taskRunId,
        reviewStatus: 'task_local',
        createdBy: document.userId,
      });
    },

    archiveMemoryDocument({ memoryDocumentId = '' } = {}) {
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const document = this.getMemoryDocument(memoryDocumentId);
        if (!document) throw new Error('Memory document not found.');
        if (document.lifecycleState === 'active') {
          const error = new Error('当前 Memory 不能直接归档，请先切换到另一份 Memory。');
          error.code = 'active_memory_archive_forbidden';
          throw error;
        }
        run(this.db, "UPDATE memory_documents SET lifecycle_state='archived',updated_at=? WHERE id=?", [nowIso(), document.id]);
        run(this.db, "UPDATE agent_context_spaces SET lifecycle_state='archived',updated_at=? WHERE memory_document_id=?", [nowIso(), document.id]);
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.getMemoryDocument(document.id);
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    restoreMemoryDocument({ memoryDocumentId = '' } = {}) {
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const document = this.getMemoryDocument(memoryDocumentId);
        if (!document) throw new Error('Memory document not found.');
        run(this.db, "UPDATE memory_documents SET lifecycle_state='inactive',updated_at=? WHERE id=?", [nowIso(), document.id]);
        run(this.db, "UPDATE agent_context_spaces SET lifecycle_state='inactive',updated_at=? WHERE memory_document_id=?", [nowIso(), document.id]);
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.getMemoryDocument(document.id);
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    renameMemoryDocument({ memoryDocumentId = '', displayName = '' } = {}) {
      const document = this.getMemoryDocument(memoryDocumentId);
      if (!document) throw new Error('Memory document not found.');
      const name = normalizeMemoryDisplayName(displayName, defaultMemoryName(document.scope, document.slotNo, document));
      run(this.db, 'UPDATE memory_documents SET display_name=?,updated_at=? WHERE id=?', [name, nowIso(), document.id]);
      return this.getMemoryDocument(document.id);
    },

    getMemoryContextDetails({ memoryDocumentId = '' } = {}) {
      const document = this.getMemoryDocument(memoryDocumentId);
      if (!document) return null;
      const messageRows = all(this.db, `SELECT * FROM messages
        WHERE visible=1 AND (memory_id=? OR (memory_id='' AND context_space_id=?))
        ORDER BY created_at,id`, [document.id, document.contextSpaceId || '']);
      const messages = messageRows.map((row) => ({
        id: row.id, role: row.role, content: row.content, createdAt: row.created_at || '',
        memoryId: row.memory_id || document.id, contextSpaceId: row.context_space_id || '',
        metadata: safeJsonParse(row.metadata_json, {}),
      }));
      const attachments = all(this.db, `SELECT ma.* FROM message_attachments ma
        JOIN messages m ON m.id=ma.message_id
        WHERE m.visible=1 AND (m.memory_id=? OR (m.memory_id='' AND m.context_space_id=?))
        ORDER BY ma.created_at,ma.id`, [document.id, document.contextSpaceId || '']).map((row) => ({
        id: row.id, messageId: row.message_id || '', relationType: row.relation_type || 'attachment',
        fileId: row.file_id || '', name: row.name || '', contentType: row.content_type || '',
        sizeBytes: Number(row.size_bytes || 0), contentHash: row.sha256 || '', metadata: safeJsonParse(row.metadata_json, {}),
        createdAt: row.created_at || '',
      }));
      const contextStates = all(this.db, `SELECT * FROM chat_context_states WHERE context_space_id=? ORDER BY updated_at DESC,id`, [document.contextSpaceId || ''])
        .map((row) => ({
          id: row.id, sessionId: row.session_id || '', contextSpaceId: row.context_space_id || '',
          contextEpoch: Number(row.context_epoch || 1), resetAfterMessageId: row.reset_after_message_id || '',
          resetAfterCreatedAt: row.reset_after_created_at || '', providerCompactionDetected: Boolean(row.provider_compaction_detected),
          updatedAt: row.updated_at || '',
        }));
      const latest = [...messages].reverse().find((message) => String(message.content || '').trim());
      return {
        document: {
          ...document,
          messageCount: messages.length,
          fileCount: attachments.length,
          summary: summarizeMemoryContext(latest?.content || document.content || ''),
          lastUsedAt: latest?.createdAt || document.updatedAt || document.createdAt,
        },
        messages,
        attachments,
        contextStates,
      };
    },

    restoreAndSwitchCurrentMemory({
      agentInstanceId = '', memoryDocumentId = '', deviceId = '', workspaceId = '', expectedStateRevision,
      expectedActiveContextSpaceId, expectedActiveMemoryDocumentId,
    } = {}) {
      const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const document = this.getMemoryDocument(memoryDocumentId);
        if (!document || document.lifecycleState !== 'archived') throw new Error('Archived Memory was not found.');
        run(this.db, "UPDATE memory_documents SET lifecycle_state='inactive',updated_at=? WHERE id=?", [nowIso(), document.id]);
        run(this.db, "UPDATE agent_context_spaces SET lifecycle_state='inactive',updated_at=? WHERE memory_document_id=?", [nowIso(), document.id]);
        const switched = this.switchCurrentMemory({
          agentInstanceId, memoryDocumentId, deviceId: resolvedDeviceId, workspaceId,
          expectedStateRevision, expectedActiveContextSpaceId, expectedActiveMemoryDocumentId, withinTransaction: true,
        });
        this.db.exec('COMMIT');
        return switched;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    switchCurrentMemory({
      agentInstanceId = '', memoryDocumentId = '', deviceId = '', workspaceId = '', expectedStateRevision,
      expectedActiveContextSpaceId, expectedActiveMemoryDocumentId, withinTransaction = false,
    } = {}) {
      const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
      const instance = this.getUserAgentInstance(agentInstanceId);
      const document = this.getMemoryDocument(memoryDocumentId);
      if (!instance || !document || document.userAgentInstanceId !== instance.id || document.userId !== instance.userId) throw new Error('Memory document ownership mismatch.');
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: instance.userId, workspaceId, deviceId: resolvedDeviceId }) || 'workspace_personal';
      if (document.workspaceId !== resolvedWorkspaceId) throw new Error('Memory document workspace mismatch.');
      if (document.scope !== 'general') throw new Error('Only general Memory can become the current Memory.');
      if (document.lifecycleState === 'archived') throw new Error('Archived Memory must be restored before activation.');
      const pointedContext = this.getAgentContextSpace(document.contextSpaceId);
      const context = pointedContext?.workspaceId === resolvedWorkspaceId
        && pointedContext.userId === instance.userId
        && pointedContext.userAgentInstanceId === instance.id
        && pointedContext.contextKind === 'general_memory'
        && pointedContext.memoryDocumentId === document.id
        ? pointedContext
        : this.listAgentContextSpaces({
          userId: instance.userId, agentInstanceId: instance.id, workspaceId: resolvedWorkspaceId,
        }).find((item) => item.contextKind === 'general_memory' && item.memoryDocumentId === document.id)
          || this.ensureAgentContextSpace({
        userId: instance.userId, agentInstanceId: instance.id, contextKind: 'general_memory', memoryDocumentId: document.id, workspaceId: resolvedWorkspaceId,
          });
      this.switchAgentContext({ deviceId: resolvedDeviceId, userId: instance.userId, agentInstanceId: instance.id,
        contextSpaceId: context.id, reason: 'memory_switch', workspaceId: resolvedWorkspaceId,
        expectedStateRevision, expectedActiveContextSpaceId, expectedActiveMemoryDocumentId, withinTransaction });
      if (document.contextSpaceId !== context.id) {
        run(this.db, 'UPDATE memory_documents SET context_space_id=?,updated_at=? WHERE id=?', [context.id, nowIso(), document.id]);
      }
      this.recordMemoryAccessAudit?.({ requesterUserId: instance.userId, requesterAgentInstanceId: instance.id,
        targetUserId: instance.userId, targetAgentInstanceId: instance.id, contextSpaceId: context.id,
        memoryDocumentId: document.id, memoryCloudKey: document.cloudKey, memoryDocumentVersionId: document.currentVersionId,
        action: 'switch', reason: 'user_selected_memory', result: 'allowed', resultCode: 'ALLOWED' });
      return this.getMemoryDocument(document.id);
    },

    clearCurrentMemory({ agentInstanceId = '', deviceId = '', workspaceId = '' } = {}) {
      const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) throw new Error('User Agent instance not found.');
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: instance.userId, workspaceId, deviceId: resolvedDeviceId }) || 'workspace_personal';
      const state = this.ensureDeviceContextState?.({ deviceId: resolvedDeviceId, userId: instance.userId,
        agentInstanceId: instance.id, workspaceId: resolvedWorkspaceId });
      const current = this.getMemoryDocument(state?.activeMemoryDocumentId || '');
      if (!current || current.workspaceId !== resolvedWorkspaceId || current.scope !== 'general') throw new Error('Current general Memory was not found.');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, "UPDATE memory_documents SET lifecycle_state='archived',updated_at=? WHERE id=?", [nowIso(), current.id]);
        run(this.db, "UPDATE agent_context_spaces SET lifecycle_state='archived',updated_at=? WHERE memory_document_id=?", [nowIso(), current.id]);
        run(this.db, "UPDATE memory_documents SET lifecycle_state='inactive',updated_at=? WHERE account_workspace_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state='active'", [nowIso(), resolvedWorkspaceId, instance.id]);
        const next = this.createMemoryDocument({ agentInstanceId: instance.id, scope: 'general', sourceKind: 'memory_cleared',
          sourceId: current.id, deviceId: resolvedDeviceId, workspaceId: resolvedWorkspaceId, withinTransaction: true });
        const context = this.getAgentContextSpace(next.contextSpaceId) || this.ensureAgentContextSpace({
          userId: instance.userId, agentInstanceId: instance.id, contextKind: 'general_memory', memoryDocumentId: next.id, workspaceId: resolvedWorkspaceId,
        });
        const primary = this.getPrimaryAgentSession?.({ userId: instance.userId, agentInstanceId: instance.id, workspaceId: resolvedWorkspaceId });
        run(this.db, `UPDATE agent_device_context_state SET primary_session_id=?,active_context_space_id=?,active_memory_document_id=?,updated_at=?
          WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [primary?.id || '',context.id,next.id,nowIso(),instance.userId,resolvedWorkspaceId,instance.id]);
        this.stageAgentContextState?.({
          userId: instance.userId, agentInstanceId: instance.id, deviceId: resolvedDeviceId,
          primarySessionId: primary?.id || '', activeContextSpaceId: context.id, activeMemoryDocumentId: next.id,
          reason: 'memory_cleared', workspaceId: resolvedWorkspaceId,
        });
        this.recordMemoryAccessAudit?.({ requesterUserId: instance.userId, requesterAgentInstanceId: instance.id,
          targetUserId: instance.userId, targetAgentInstanceId: instance.id, contextSpaceId: context.id,
          memoryDocumentId: current.id, memoryCloudKey: current.cloudKey, memoryDocumentVersionId: current.currentVersionId,
          action: 'clear', reason: 'user_cleared_memory', result: 'allowed', resultCode: 'ALLOWED' });
        this.db.exec('COMMIT');
        return { archived: this.getMemoryDocument(current.id), current: this.getMemoryDocument(next.id), contextSpace: context, threadReset: false };
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    resolveMemoryContext({
      agentInstanceId = '',
      taskRunId = '',
      projectId = '',
      relationshipId = '',
      purpose = 'runtime',
      includeGeneral = true,
      deviceId = '',
      contextSpaceId = '',
      workspaceId = '',
    } = {}) {
      if (!agentInstanceId) return emptyMemoryResolution();
      const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
      const instance = this.getUserAgentInstance(agentInstanceId);
      if (!instance) return emptyMemoryResolution();
      const task = taskRunId ? this.getTaskRun?.(taskRunId) : null;
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({
        userId: instance.userId, workspaceId: workspaceId || task?.workspaceId || task?.accountWorkspaceId, deviceId: resolvedDeviceId,
      }) || 'workspace_personal';
      const state = this.ensureDeviceContextState?.({ deviceId: resolvedDeviceId, userId: instance.userId,
        agentInstanceId, workspaceId: resolvedWorkspaceId });
      const selectedContext = this.getAgentContextSpace?.(contextSpaceId || state?.activeContextSpaceId || '');
      if (selectedContext && selectedContext.workspaceId !== resolvedWorkspaceId) throw new Error('Memory context workspace mismatch.');
      const resolvedTaskRunId = taskRunId || (selectedContext?.contextKind === 'task' ? selectedContext.taskRunId : '');
      const resolvedProjectId = projectId || (selectedContext?.contextKind === 'project' ? selectedContext.projectId : '');
      const resolvedRelationshipId = relationshipId || (selectedContext?.contextKind === 'relationship' ? selectedContext.relationshipUserId : '');
      const currentGeneralId = state?.activeMemoryDocumentId || get(this.db, `SELECT id FROM memory_documents WHERE account_workspace_id=? AND user_agent_instance_id=?
        AND scope='general' AND lifecycle_state='active' ORDER BY updated_at DESC,slot_no DESC,id DESC LIMIT 1`, [resolvedWorkspaceId, agentInstanceId])?.id || '';
      const rows = all(this.db, `SELECT md.*,mdv.content AS current_content,
        mdv.encryption_algorithm AS current_encryption_algorithm,mdv.encryption_key_id AS current_encryption_key_id,
        mdv.encryption_key_version AS current_encryption_key_version,mdv.content_ciphertext AS current_content_ciphertext,
        mdv.content_nonce AS current_content_nonce,mdv.content_tag AS current_content_tag,mdv.content_aad AS current_content_aad
        FROM memory_documents md LEFT JOIN memory_document_versions mdv ON mdv.id=md.current_version_id
        WHERE md.account_workspace_id=? AND md.user_agent_instance_id=? AND md.lifecycle_state!='archived'
        ORDER BY CASE md.scope WHEN 'general' THEN 0 WHEN 'project' THEN 1 WHEN 'relationship' THEN 2 WHEN 'task' THEN 3 ELSE 9 END,
          md.slot_no,md.created_at`, [resolvedWorkspaceId, agentInstanceId]);
      const selected = rows.filter((row) => {
        if (!allowedForPurpose(row, purpose)) return false;
        if (row.scope === 'general') return includeGeneral && row.id === currentGeneralId;
        if (row.scope === 'task') return Boolean(resolvedTaskRunId) && row.task_run_id === resolvedTaskRunId;
        if (row.scope === 'project') return Boolean(resolvedProjectId) && row.project_id === resolvedProjectId;
        if (row.scope === 'relationship') return Boolean(resolvedRelationshipId) && (row.relationship_user_id === resolvedRelationshipId || row.relationship_id === resolvedRelationshipId);
        return false;
      }).map((row) => normalizeMemoryRow(row, this));
      const content = selected.map((document) => `<!-- JANUS MEMORY:${document.scope}:${document.id} -->\n${document.content || ''}`.trim()).filter(Boolean).join('\n\n');
      return {
        documents: selected,
        contextSpace: selectedContext || null,
        content,
        manifestHash: sha256Text(JSON.stringify(selected.map((item) => ({
          id: item.id,
          currentVersionId: item.currentVersionId,
          contentHash: item.contentHash,
          scope: item.scope,
          taskRunId: item.taskRunId,
          projectId: item.projectId,
          relationshipId: item.relationshipId,
        })))),
      };
    },

    ensureTaskSecurityContext({
      taskRunId = '',
      ownerUserId = '',
      cloudEvolutionAllowed = false,
      cloudCollaborationAllowed = false,
    } = {}) {
      if (!taskRunId) throw new Error('Task security context requires taskRunId.');
      const task = get(this.db, 'SELECT owner_user_id FROM task_runs WHERE id=?', [taskRunId]);
      const resolvedOwner = ownerUserId || task?.owner_user_id || '';
      const existing = get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]);
      if (existing) {
        ensureLocalTaskEnvelope(this, existing);
        if ((cloudEvolutionAllowed && !Number(existing.cloud_evolution_allowed))
          || (cloudCollaborationAllowed && !Number(existing.cloud_collaboration_allowed))) {
          run(this.db, `UPDATE task_security_contexts SET
            cloud_evolution_allowed=CASE WHEN ? THEN 1 ELSE cloud_evolution_allowed END,
            cloud_collaboration_allowed=CASE WHEN ? THEN 1 ELSE cloud_collaboration_allowed END,
            cloud_envelope_state='pending',updated_at=? WHERE task_run_id=?`, [
            cloudEvolutionAllowed ? 1 : 0, cloudCollaborationAllowed ? 1 : 0, nowIso(), taskRunId,
          ]);
        }
        if (cloudEvolutionAllowed || cloudCollaborationAllowed) {
          ensureCloudTaskEnvelope(this, get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
        }
        return normalizeTaskSecurity(get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
      }
      const now = nowIso();
      run(this.db, `INSERT INTO task_security_contexts (
        task_run_id,owner_user_id,local_key_id,cloud_key_id,key_version,cloud_evolution_allowed,cloud_collaboration_allowed,
        local_envelope_state,cloud_envelope_state,status,created_at,updated_at
      ) VALUES (?,?,?,?,1,?,?,'reference_only',?,'active',?,?)`, [
        taskRunId, resolvedOwner, newId('task_local_key'), newId('task_cloud_key'), cloudEvolutionAllowed ? 1 : 0,
        cloudCollaborationAllowed ? 1 : 0,
        cloudEvolutionAllowed || cloudCollaborationAllowed ? 'pending' : 'disabled', now, now,
      ]);
      ensureLocalTaskEnvelope(this, get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
      if (cloudEvolutionAllowed || cloudCollaborationAllowed) {
        ensureCloudTaskEnvelope(this, get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
      }
      return normalizeTaskSecurity(get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
    },

    getTaskSecurityContext(taskRunId = '') {
      return normalizeTaskSecurity(get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
    },

    setTaskCloudEvolutionAllowed({ taskRunId = '', allowed = false } = {}) {
      const context = this.ensureTaskSecurityContext({ taskRunId });
      const retainCloudEnvelope = Boolean(allowed || context.cloudCollaborationAllowed);
      run(this.db, `UPDATE task_security_contexts SET cloud_evolution_allowed=?,cloud_envelope_state=?,updated_at=?
        WHERE task_run_id=?`, [allowed ? 1 : 0, retainCloudEnvelope ? (context.cloudWrappedKey ? 'active' : 'pending') : (context.cloudWrappedKey ? 'revoked' : 'disabled'), nowIso(), taskRunId]);
      if (allowed) ensureCloudTaskEnvelope(this, get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
      run(this.db, `UPDATE memory_documents SET allow_cluster_evolution=?,consent_scope_json=?,updated_at=?
        WHERE scope='task' AND task_run_id=?`, [allowed ? 1 : 0, JSON.stringify({ taskProcessing: true, cloudEvolution: Boolean(allowed) }), nowIso(), taskRunId]);
      return normalizeTaskSecurity(get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
    },

    prepareTaskCloudCollaborationEnvelope({ taskRunId = '', keyring = null } = {}) {
      this.ensureTaskSecurityContext({ taskRunId });
      run(this.db, `UPDATE task_security_contexts SET cloud_collaboration_allowed=1,
        cloud_envelope_state=CASE WHEN cloud_wrapped_key!='' THEN 'active' ELSE 'pending' END,updated_at=?
        WHERE task_run_id=?`, [nowIso(), taskRunId]);
      ensureCloudTaskEnvelope(
        this,
        get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]),
        keyring || cloudTaskMemoryPublicKeyringFromEnv(),
      );
      return normalizeTaskSecurity(get(this.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]));
    },

    ensurePendingTaskCloudEnvelopes({ keyring = null } = {}) {
      const resolvedKeyring = keyring || cloudTaskMemoryPublicKeyringFromEnv();
      let activated = 0;
      for (const row of all(this.db, `SELECT * FROM task_security_contexts
        WHERE (cloud_evolution_allowed=1 OR cloud_collaboration_allowed=1)
          AND status='active'`)) {
        const before = row.cloud_envelope_state;
        const beforeKeyId = row.cloud_wrapping_key_id || '';
        const after = ensureCloudTaskEnvelope(this, row, resolvedKeyring);
        if ((before !== 'active' || beforeKeyId !== (after?.cloud_wrapping_key_id || ''))
          && after?.cloud_envelope_state === 'active') activated += 1;
      }
      return { activated };
    },

    decryptMemoryVersionContent(row = {}) {
      return decryptMemoryContent(this, row, '');
    },

    protectMemoryVersionContent({ document = {}, versionNo = 1, content = '' } = {}) {
      return protectMemoryContent(this, {
        scope: document.scope || 'general', taskRunId: document.task_run_id || document.taskRunId || '',
        documentId: document.id || '', versionNo, content,
      });
    },
  });
}

function normalizeMemoryScope(value) {
  const scope = String(value || 'general').trim().toLowerCase();
  if (!MEMORY_SCOPES.has(scope)) throw new Error(`Unsupported Memory scope: ${scope}`);
  return scope;
}

function assertScopeIdentity(scope, { taskRunId, projectId, relationshipId }) {
  if (scope === 'task' && !taskRunId) throw new Error('Task Memory requires taskRunId.');
  if (scope === 'project' && !projectId) throw new Error('Project Memory requires projectId.');
  if (scope === 'relationship' && !relationshipId) throw new Error('Relationship Memory requires relationshipId.');
}

function resolveSlotNo(db, workspaceId, instanceId, scope, slotNo, identity) {
  if (slotNo !== undefined && slotNo !== null && String(slotNo) !== '') return Math.max(0, Number(slotNo));
  if (scope !== 'general') return 0;
  return Number(get(db, `SELECT COALESCE(MAX(slot_no),-1)+1 AS value FROM memory_documents
    WHERE account_workspace_id=? AND user_agent_instance_id=? AND scope='general' AND task_run_id='' AND project_id='' AND relationship_id=''`, [workspaceId, instanceId])?.value || 0);
}

function findScopedDocument(db, workspaceId, instanceId, scope, slotNo, { taskRunId, projectId, relationshipId }) {
  return get(db, `SELECT id FROM memory_documents WHERE account_workspace_id=? AND user_agent_instance_id=? AND scope=? AND slot_no=?
    AND task_run_id=? AND project_id=? AND relationship_id=?`, [workspaceId, instanceId, scope, slotNo, taskRunId || '', projectId || '', relationshipId || '']);
}

function defaultMemoryName(scope, slotNo, { taskRunId, projectId, relationshipId }) {
  if (scope === 'general') return `新对话 ${Number(slotNo || 0) + 1}`;
  if (scope === 'task') return `task-${taskRunId}.md`;
  if (scope === 'project') return `project-${projectId}.md`;
  return `relationship-${relationshipId}.md`;
}

function normalizeMemoryDisplayName(value = '', fallback = '新对话') {
  const trimmed = String(value || '').trim().replace(/\s+/g, ' ');
  const visible = [...trimmed].slice(0, 60).join('');
  return visible || String(fallback || '新对话').trim().slice(0, 60) || '新对话';
}

function summarizeMemoryContext(value = '') {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, 96).join('') || '尚未开始对话';
}

function emptyMemoryContent(name, scope) {
  return `# ${name}\n\n## Stable Learnings\n\n## Reusable Preferences\n\n## Failure Modes\n\n## Workflow Notes\n\n<!-- scope:${scope} -->\n`;
}

function delegationTaskMemoryHistory(content = '') {
  const text = String(content || '').trim();
  if (!text) return '';
  const updatesIndex = text.indexOf('## Task Updates');
  if (updatesIndex >= 0) return text.slice(updatesIndex).trim().slice(0, 20000);
  const notesIndex = text.indexOf('## Collaboration Notes');
  if (notesIndex >= 0) return text.slice(notesIndex).trim().slice(0, 20000);
  return text.slice(0, 20000);
}

function allowedForPurpose(row, purpose) {
  if (purpose === 'personal_evolution') return Boolean(row.allow_personal_evolution);
  if (purpose === 'cluster_evolution') return Boolean(row.sync_enabled);
  return true;
}

function normalizeMemoryRow(row, store) {
  const resolvedContent = resolveMemoryContent(store, row, 'current_');
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    userId: row.user_id,
    userAgentInstanceId: row.user_agent_instance_id,
    agentFamilyId: row.agent_family_id || '',
    cloudKey: row.cloud_key || row.id,
    scope: row.scope,
    slotNo: Number(row.slot_no || 0),
    displayName: row.display_name,
    taskRunId: row.task_run_id || '',
    projectId: row.project_id || '',
    relationshipId: row.relationship_id || '',
    relationshipUserId: row.relationship_user_id || '',
    delegationId: row.delegation_id || '',
    groupId: row.group_id || '',
    contextSpaceId: row.context_space_id || '',
    workScopeId: row.work_scope_id || '',
    lifecycleState: row.lifecycle_state,
    visibility: row.visibility,
    syncEnabled: Boolean(row.sync_enabled),
    allowPersonalEvolution: Boolean(row.allow_personal_evolution),
    allowClusterEvolution: Boolean(row.allow_cluster_evolution),
    sourceConversationCursor: row.source_conversation_cursor || '',
    encryptionKeyId: row.encryption_key_id || '',
    consentScope: safeJsonParse(row.consent_scope_json, {}),
    currentVersionId: row.current_version_id || '',
    contentHash: row.content_hash || '',
    content: resolvedContent.content,
    decryptionState: resolvedContent.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTaskSecurity(row) {
  if (!row) return null;
  return {
    taskRunId: row.task_run_id,
    ownerUserId: row.owner_user_id || '',
    localKeyId: row.local_key_id,
    cloudKeyId: row.cloud_key_id,
    keyVersion: Number(row.key_version || 1),
    cloudEvolutionAllowed: Boolean(row.cloud_evolution_allowed),
    cloudCollaborationAllowed: Boolean(row.cloud_collaboration_allowed),
    localEnvelopeState: row.local_envelope_state,
    cloudEnvelopeState: row.cloud_envelope_state,
    localWrapAlgorithm: row.local_wrap_algorithm || '',
    localWrappingKeyId: row.local_wrapping_key_id || '',
    localWrappedKey: row.local_wrapped_key || '',
    localWrapNonce: row.local_wrap_nonce || '',
    localWrapTag: row.local_wrap_tag || '',
    cloudWrapAlgorithm: row.cloud_wrap_algorithm || '',
    cloudWrappingKeyId: row.cloud_wrapping_key_id || '',
    cloudWrappedKey: row.cloud_wrapped_key || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureLocalTaskEnvelope(store, row) {
  if (!row || row.local_wrapped_key) return row;
  if (!store.taskMemoryKeyring?.available()) throw new Error('Task Memory local key storage is unavailable.');
  const dataKey = crypto.randomBytes(32);
  const envelope = store.taskMemoryKeyring.wrapTaskKey(dataKey, { taskRunId: row.task_run_id, keyVersion: row.key_version });
  run(store.db, `UPDATE task_security_contexts SET local_envelope_state='active',local_wrap_algorithm=?,
    local_wrapping_key_id=?,local_wrapped_key=?,local_wrap_nonce=?,local_wrap_tag=?,updated_at=? WHERE task_run_id=?`, [
    envelope.algorithm, envelope.wrappingKeyId, envelope.ciphertext, envelope.nonce, envelope.tag, nowIso(), row.task_run_id,
  ]);
  return get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [row.task_run_id]);
}

function ensureCloudTaskEnvelope(store, row, keyring = cloudTaskMemoryPublicKeyringFromEnv()) {
  if (!row || (!Number(row.cloud_evolution_allowed) && !Number(row.cloud_collaboration_allowed))) return row;
  const activeKeyId = String(keyring.activeKeyId || '');
  if (row.cloud_wrapped_key) {
    if (activeKeyId && keyring.keys?.[activeKeyId] && row.cloud_wrapping_key_id !== activeKeyId) {
      const dataKey = unwrapLocalTaskDataKey(store, ensureLocalTaskEnvelope(store, row));
      const rotated = wrapTaskKeyForCloud(dataKey, keyring);
      run(store.db, `UPDATE task_security_contexts SET cloud_envelope_state='active',cloud_wrap_algorithm=?,
        cloud_wrapping_key_id=?,cloud_wrapped_key=?,updated_at=? WHERE task_run_id=?`, [
        rotated.algorithm, rotated.keyId, rotated.wrappedKey, nowIso(), row.task_run_id,
      ]);
      return get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [row.task_run_id]);
    }
    if (row.cloud_envelope_state !== 'active') {
      run(store.db, "UPDATE task_security_contexts SET cloud_envelope_state='active',updated_at=? WHERE task_run_id=?", [nowIso(), row.task_run_id]);
      return get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [row.task_run_id]);
    }
    return row;
  }
  if (!activeKeyId || !keyring.keys?.[activeKeyId]) return row;
  const local = ensureLocalTaskEnvelope(store, row);
  const dataKey = unwrapLocalTaskDataKey(store, local);
  const envelope = wrapTaskKeyForCloud(dataKey, keyring);
  run(store.db, `UPDATE task_security_contexts SET cloud_envelope_state='active',cloud_wrap_algorithm=?,
    cloud_wrapping_key_id=?,cloud_wrapped_key=?,updated_at=? WHERE task_run_id=?`, [
    envelope.algorithm, envelope.keyId, envelope.wrappedKey, nowIso(), row.task_run_id,
  ]);
  return get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [row.task_run_id]);
}

function unwrapLocalTaskDataKey(store, row) {
  if (!row?.local_wrapped_key) throw new Error('Task Memory local key envelope is missing.');
  return store.taskMemoryKeyring.unwrapTaskKey({
    algorithm: row.local_wrap_algorithm,
    wrappingKeyId: row.local_wrapping_key_id,
    ciphertext: row.local_wrapped_key,
    nonce: row.local_wrap_nonce,
    tag: row.local_wrap_tag,
  }, { taskRunId: row.task_run_id, keyVersion: row.key_version });
}

function protectMemoryContent(store, { scope, taskRunId, documentId, versionNo, content }) {
  if (scope !== 'task') return { content, algorithm: '', keyId: '', keyVersion: 0, ciphertext: '', nonce: '', tag: '', aad: '' };
  const security = ensureLocalTaskEnvelope(store, get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId])
    || rawTaskSecurityContext(store, taskRunId));
  const encrypted = encryptTaskMemoryContent(content, unwrapLocalTaskDataKey(store, security), {
    documentId, versionNo, keyVersion: security.key_version,
  });
  return { content: '', algorithm: encrypted.algorithm, keyId: security.local_key_id, keyVersion: security.key_version,
    ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, tag: encrypted.tag, aad: encrypted.aad };
}

function rawTaskSecurityContext(store, taskRunId) {
  store.ensureTaskSecurityContext({ taskRunId });
  return get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [taskRunId]);
}

function resolveMemoryContent(store, row, prefix) {
  const algorithm = row[`${prefix}encryption_algorithm`] || '';
  if (!algorithm) return { content: row[`${prefix}content`] || '', state: 'plaintext_legacy' };
  try { return { content: decryptMemoryContent(store, row, prefix), state: 'decrypted' }; }
  catch { return { content: '', state: 'unavailable' }; }
}

function decryptMemoryContent(store, row, prefix = '') {
  const algorithm = row[`${prefix}encryption_algorithm`] || '';
  if (!algorithm) return row[`${prefix}content`] || '';
  const documentId = row.memory_document_id || row.id || '';
  const document = get(store.db, 'SELECT task_run_id FROM memory_documents WHERE id=?', [documentId]);
  if (!document?.task_run_id) throw new Error('Encrypted Memory version is not bound to a task.');
  const security = get(store.db, 'SELECT * FROM task_security_contexts WHERE task_run_id=?', [document.task_run_id]);
  return decryptTaskMemoryContent({
    algorithm,
    ciphertext: row[`${prefix}content_ciphertext`] || '',
    nonce: row[`${prefix}content_nonce`] || '',
    tag: row[`${prefix}content_tag`] || '',
    aad: row[`${prefix}content_aad`] || '',
  }, unwrapLocalTaskDataKey(store, security));
}

function emptyMemoryResolution() {
  return { documents: [], content: '', manifestHash: sha256Text('[]') };
}
