import { all, get, run } from '../../../db.js';
import { nowIso, safeJsonParse } from '../../../utils.js';

const TIMELINE_SOURCE_KINDS = new Set(['direct', 'task', 'chat_group', 'collaboration_group', 'delegation']);

export function installAgentConversationWindowStoreMethods(prototype) {
  Object.assign(prototype, {
    agentConversationWindowId(agentInstanceId = '', workspaceId = '') {
      const canonical = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const scope = String(workspaceId || '').trim();
      return canonical ? `account:${scope || 'unknown'}:agent:${canonical}` : '';
    },

    recordAgentConversationBranch({ session = null, rebuildRequired = false } = {}) {
      let item = typeof session === 'string' ? this.getSession?.(session) : session;
      if (!item?.id || !item.userId || !item.agentInstanceId || item.readOnly || item.status === 'deleted') return null;
      this.ensureConversationForSession?.(item);
      item = this.getSession?.(item.id) || item;
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(item.agentInstanceId) || item.agentInstanceId;
      const workspaceId = item.accountWorkspaceId || item.workspaceId || 'workspace_personal';
      const conversationId = item.conversationId || item.id;
      run(this.db, `INSERT INTO agent_conversation_branch_state(
        user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,thread_generation,rebuild_required,updated_at
      ) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(user_id,account_workspace_id,agent_instance_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,primary_session_id=excluded.primary_session_id,
        rebuild_required=MAX(agent_conversation_branch_state.rebuild_required,excluded.rebuild_required),updated_at=excluded.updated_at`, [
        item.userId, workspaceId, canonicalAgentInstanceId, conversationId, item.id, rebuildRequired ? 1 : 0, nowIso(),
      ]);
      return this.getAgentConversationBranch({
        userId: item.userId, workspaceId, agentInstanceId: canonicalAgentInstanceId,
      });
    },

    getAgentConversationBranch({ userId = '', workspaceId = '', agentInstanceId = '' } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      if (!userId || !canonicalAgentInstanceId) return null;
      const row = get(this.db, `SELECT branch.*,session.codex_thread_id,session.title,session.department_id,session.agent_id,
          session.status AS session_status,session.write_state,session.conversation_role
        FROM agent_conversation_branch_state branch LEFT JOIN sessions session ON session.id=branch.primary_session_id
        WHERE branch.user_id=? AND branch.account_workspace_id=? AND branch.agent_instance_id=?`, [
        userId, resolvedWorkspaceId, canonicalAgentInstanceId,
      ]);
      return normalizeBranch(row);
    },

    listAgentConversationBranches({ userId = '', agentInstanceId = '' } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      if (!userId || !canonicalAgentInstanceId) return [];
      return all(this.db, `SELECT branch.*,session.codex_thread_id,session.title,session.department_id,session.agent_id,
          session.status AS session_status,session.write_state,session.conversation_role,
          workspace.workspace_kind,workspace.name AS workspace_name,membership.role AS workspace_role,membership.status AS membership_status
        FROM agent_conversation_branch_state branch
        LEFT JOIN sessions session ON session.id=branch.primary_session_id
        LEFT JOIN account_workspaces workspace ON workspace.id=branch.account_workspace_id
        LEFT JOIN account_workspace_memberships membership ON membership.workspace_id=branch.account_workspace_id AND membership.user_id=branch.user_id
        WHERE branch.user_id=? AND branch.agent_instance_id=? ORDER BY workspace.workspace_kind,workspace.name,branch.account_workspace_id`, [
        userId, canonicalAgentInstanceId,
      ]).map(normalizeBranch);
    },

    markAgentConversationBranchReady({ userId = '', workspaceId = '', agentInstanceId = '', timelineSequence = 0 } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      run(this.db, `UPDATE agent_conversation_branch_state SET rebuild_required=0,
        last_injected_timeline_sequence=MAX(last_injected_timeline_sequence,?),updated_at=?
        WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
        Math.max(0, Number(timelineSequence || 0)), nowIso(), userId, resolvedWorkspaceId, canonicalAgentInstanceId,
      ]);
      return this.getAgentConversationBranch({ userId, workspaceId: resolvedWorkspaceId, agentInstanceId: canonicalAgentInstanceId });
    },

    latestAgentConversationTimelineSequence({ userId = '', workspaceId = '', agentInstanceId = '' } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const resolvedWorkspaceId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
      return Number(get(this.db, `SELECT COALESCE(MAX(sequence_no),0) AS sequence FROM agent_conversation_timeline_refs
        WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [
        userId, resolvedWorkspaceId, canonicalAgentInstanceId,
      ])?.sequence || 0);
    },

    upsertAgentConversationTimelineRef({
      userId = '', workspaceId = '', agentInstanceId = '', sourceKind = 'direct', sourceId = '',
      sourceConversationId = '', sourceMessageId = '', occurredAt = '', metadata = {},
    } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const resolvedWorkspaceId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
      const cleanSourceKind = String(sourceKind || '').trim();
      const cleanSourceId = String(sourceId || '').trim();
      if (!userId || !canonicalAgentInstanceId || !TIMELINE_SOURCE_KINDS.has(cleanSourceKind) || !cleanSourceId) return null;
      const refId = `${cleanSourceKind}:${cleanSourceId}:${canonicalAgentInstanceId}`;
      run(this.db, `INSERT INTO agent_conversation_timeline_refs(
        ref_id,user_id,account_workspace_id,agent_instance_id,source_kind,source_id,source_conversation_id,
        source_message_id,occurred_at,metadata_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_instance_id,source_kind,source_id) DO UPDATE SET
        user_id=excluded.user_id,account_workspace_id=excluded.account_workspace_id,
        source_conversation_id=excluded.source_conversation_id,source_message_id=excluded.source_message_id,
        occurred_at=excluded.occurred_at,metadata_json=excluded.metadata_json`, [
        refId, userId, resolvedWorkspaceId, canonicalAgentInstanceId, cleanSourceKind, cleanSourceId,
        sourceConversationId || '', sourceMessageId || '', occurredAt || nowIso(), JSON.stringify(metadata || {}),
      ]);
      return get(this.db, `SELECT * FROM agent_conversation_timeline_refs
        WHERE agent_instance_id=? AND source_kind=? AND source_id=?`, [canonicalAgentInstanceId, cleanSourceKind, cleanSourceId]);
    },

    indexAgentConversationMessage(messageOrId) {
      const message = typeof messageOrId === 'string' ? this.getMessage?.(messageOrId) : messageOrId;
      if (!message?.id || !message.agentInstanceId || message.visible === false) return null;
      const session = message.sessionId ? this.getSession?.(message.sessionId) : null;
      const userId = session?.userId || message.senderUserId || '';
      if (!userId) return null;
      return this.upsertAgentConversationTimelineRef({
        userId,
        workspaceId: message.accountWorkspaceId || session?.accountWorkspaceId || 'workspace_personal',
        agentInstanceId: message.agentInstanceId,
        sourceKind: message.taskRunId || message.taskWorkspaceId ? 'task' : 'direct',
        sourceId: message.id,
        sourceConversationId: message.conversationId || session?.conversationId || session?.id || '',
        sourceMessageId: message.id,
        occurredAt: message.createdAt || nowIso(),
        metadata: { role: message.role || '', sourceSessionId: message.sessionId || '' },
      });
    },

    rebuildAgentConversationTimelineRefs({ userId = '', agentInstanceId = '' } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const instance = canonicalAgentInstanceId ? this.getUserAgentInstance?.(canonicalAgentInstanceId) : null;
      if (!userId || !instance || instance.userId !== userId) return { indexed: 0 };
      let indexed = 0;
      const directRows = all(this.db, `SELECT message.id FROM messages message JOIN sessions session ON session.id=message.session_id
        WHERE session.user_id=? AND session.status!='deleted' AND message.visible=1 AND
          (message.agent_instance_id=? OR (message.agent_instance_id='' AND session.agent_instance_id=?))`, [
        userId, canonicalAgentInstanceId, canonicalAgentInstanceId,
      ]);
      for (const row of directRows) if (this.indexAgentConversationMessage(row.id)) indexed += 1;

      const taskRunIds = new Set(all(this.db, `SELECT id FROM task_runs WHERE owner_user_id=? AND lead_agent_instance_id=?
        UNION SELECT node.task_run_id AS id FROM task_nodes node JOIN task_runs task ON task.id=node.task_run_id
          WHERE task.owner_user_id=? AND node.agent_instance_id=?`, [
        userId, canonicalAgentInstanceId, userId, canonicalAgentInstanceId,
      ]).map((row) => String(row.id || '')).filter(Boolean));
      if (taskRunIds.size) {
        const placeholders = [...taskRunIds].map(() => '?').join(',');
        for (const row of all(this.db, `SELECT id FROM messages WHERE task_run_id IN (${placeholders})`, [...taskRunIds])) {
          const message = this.getMessage?.(row.id);
          if (!message) continue;
          if (this.upsertAgentConversationTimelineRef({
            userId, workspaceId: message.accountWorkspaceId || 'workspace_personal', agentInstanceId: canonicalAgentInstanceId,
            sourceKind: 'task', sourceId: message.id, sourceConversationId: message.conversationId || '',
            sourceMessageId: message.id, occurredAt: message.createdAt || '', metadata: { taskRunId: message.taskRunId || '' },
          })) indexed += 1;
        }
      }

      const collaborationGroupIds = new Set();
      for (const task of all(this.db, `SELECT id,metadata_json FROM task_runs WHERE id IN (
        SELECT id FROM task_runs WHERE owner_user_id=? AND lead_agent_instance_id=?
        UNION SELECT node.task_run_id FROM task_nodes node JOIN task_runs run ON run.id=node.task_run_id
          WHERE run.owner_user_id=? AND node.agent_instance_id=?
      )`, [userId, canonicalAgentInstanceId, userId, canonicalAgentInstanceId])) {
        const metadata = safeJsonParse(task.metadata_json, {});
        const groupId = String(metadata.groupId || metadata.group_id || metadata.collaborationGroupId || metadata.collaboration_group_id || '');
        if (groupId) collaborationGroupIds.add(groupId);
      }
      for (const group of all(this.db, `SELECT id,metadata_json FROM collaboration_groups WHERE owner_user_id=?`, [userId])) {
        const metadata = safeJsonParse(group.metadata_json, {});
        const taskRunId = String(metadata.taskRunId || metadata.task_run_id || '');
        if (taskRunId && taskRunIds.has(taskRunId)) collaborationGroupIds.add(String(group.id || ''));
      }
      for (const groupId of collaborationGroupIds) {
        for (const row of all(this.db, `SELECT * FROM collaboration_group_messages WHERE group_id=?`, [groupId])) {
          if (this.upsertAgentConversationTimelineRef({
            userId, workspaceId: row.account_workspace_id || 'workspace_personal', agentInstanceId: canonicalAgentInstanceId,
            sourceKind: 'collaboration_group', sourceId: row.id, sourceConversationId: groupId,
            sourceMessageId: row.id, occurredAt: row.created_at || '', metadata: { groupId, taskRelated: true },
          })) indexed += 1;
        }
      }

      const familyInstances = this.listUserAgentInstancesByFamily?.({ userId, agentFamilyId: instance.agentFamilyId }) || [];
      if (familyInstances.length === 1) {
        for (const source of [
          ['chat_group', 'chat_group_messages', 'group_id'],
          ['collaboration_group', 'collaboration_group_messages', 'group_id'],
        ]) {
          const [kind, table, conversationColumn] = source;
          for (const row of all(this.db, `SELECT * FROM ${table} WHERE sender_agent_id=?`, [instance.agentFamilyId])) {
            const groupId = String(row[conversationColumn] || '');
            const tableName = kind === 'chat_group' ? 'chat_group_messages' : 'collaboration_group_messages';
            for (const threadRow of all(this.db, `SELECT * FROM ${tableName} WHERE ${conversationColumn}=?`, [groupId])) {
              if (this.upsertAgentConversationTimelineRef({
                userId, workspaceId: threadRow.account_workspace_id || 'workspace_personal', agentInstanceId: canonicalAgentInstanceId,
                sourceKind: kind, sourceId: threadRow.id, sourceConversationId: groupId,
                sourceMessageId: threadRow.id, occurredAt: threadRow.created_at || '', metadata: { groupId },
              })) indexed += 1;
            }
          }
        }
      }
      for (const delegation of all(this.db, `SELECT * FROM agent_delegations WHERE requester_user_id=? OR recipient_user_id=?`, [userId, userId])) {
        const metadata = safeJsonParse(delegation.metadata_json, {});
        const relatedInstanceId = String(metadata.agentInstanceId || metadata.agent_instance_id || '');
        const taskRelated = delegation.task_run_id && taskRunIds.has(String(delegation.task_run_id));
        if (relatedInstanceId !== canonicalAgentInstanceId && !taskRelated) continue;
        for (const row of all(this.db, `SELECT * FROM agent_delegation_workspace_messages WHERE delegation_id=? AND user_id=?`, [delegation.id, userId])) {
          if (this.upsertAgentConversationTimelineRef({
            userId, workspaceId: delegation.account_workspace_id || 'workspace_personal', agentInstanceId: canonicalAgentInstanceId,
            sourceKind: 'delegation', sourceId: row.id, sourceConversationId: delegation.id,
            sourceMessageId: row.id, occurredAt: row.created_at || '', metadata: { delegationId: delegation.id },
          })) indexed += 1;
        }
      }
      return { indexed };
    },

    listAgentConversationTimeline({
      userId = '', workspaceId = '', agentInstanceId = '', memoryDocumentId = '', contextSpaceId = '', before = null, limit = 100,
    } = {}) {
      const canonicalAgentInstanceId = this.resolveCanonicalAgentInstanceId?.(agentInstanceId) || String(agentInstanceId || '').trim();
      const instance = canonicalAgentInstanceId ? this.getUserAgentInstance?.(canonicalAgentInstanceId) : null;
      if (!userId || !instance || instance.userId !== userId) return { windowId: '', items: [], nextCursor: null };
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      this.rebuildAgentConversationTimelineRefs({ userId, agentInstanceId: canonicalAgentInstanceId });
      const cleanLimit = Math.max(1, Math.min(200, Number(limit || 100)));
      const where = ['ref.user_id=?', 'ref.account_workspace_id=?', 'ref.agent_instance_id=?', `(ref.source_kind NOT IN ('direct','task') OR NOT EXISTS (
        SELECT 1 FROM messages hidden_message WHERE hidden_message.id=ref.source_message_id AND hidden_message.visible=0
      ))`];
      const params = [userId, resolvedWorkspaceId, canonicalAgentInstanceId];
      if (memoryDocumentId || contextSpaceId) {
        where.push(`(ref.source_kind='direct' AND EXISTS (
          SELECT 1 FROM messages scoped_message WHERE scoped_message.id=ref.source_message_id
            AND (scoped_message.memory_id=? OR (scoped_message.memory_id='' AND scoped_message.context_space_id=?))
        ))`);
        params.push(String(memoryDocumentId || ''), String(contextSpaceId || ''));
      }
      if (before?.occurredAt) {
        where.push('(ref.occurred_at<? OR (ref.occurred_at=? AND ref.sequence_no<?))');
        params.push(String(before.occurredAt), String(before.occurredAt), Math.max(0, Number(before.sequence || 0)));
      }
      params.push(cleanLimit + 1);
      const rows = all(this.db, `SELECT ref.*,workspace.workspace_kind,workspace.name AS workspace_name,
          membership.status AS membership_status
        FROM agent_conversation_timeline_refs ref
        LEFT JOIN account_workspaces workspace ON workspace.id=ref.account_workspace_id
        LEFT JOIN account_workspace_memberships membership ON membership.workspace_id=ref.account_workspace_id AND membership.user_id=ref.user_id
        WHERE ${where.join(' AND ')} ORDER BY ref.occurred_at DESC,ref.sequence_no DESC LIMIT ?`, params);
      const hasMore = rows.length > cleanLimit;
      const page = rows.slice(0, cleanLimit);
      const items = page.map((row) => hydrateTimelineRef(this, row, { accessible: row.membership_status === 'active' })).reverse();
      const oldest = page.at(-1);
      return {
        windowId: this.agentConversationWindowId(canonicalAgentInstanceId, resolvedWorkspaceId),
        workspaceId: resolvedWorkspaceId,
        agentInstanceId: canonicalAgentInstanceId,
        items,
        nextCursor: hasMore && oldest ? { occurredAt: oldest.occurred_at || '', sequence: Number(oldest.sequence_no || 0) } : null,
      };
    },
  });
}

function normalizeBranch(row) {
  if (!row) return null;
  return {
    userId: row.user_id || '', workspaceId: row.account_workspace_id || 'workspace_personal',
    agentInstanceId: row.agent_instance_id || '', conversationId: row.conversation_id || '',
    primarySessionId: row.primary_session_id || '', threadGeneration: Number(row.thread_generation || 1),
    rebuildRequired: Boolean(row.rebuild_required), lastInjectedTimelineSequence: Number(row.last_injected_timeline_sequence || 0),
    codexThreadId: row.codex_thread_id || '', title: row.title || '', departmentId: row.department_id || '', agentId: row.agent_id || '',
    workspaceKind: row.workspace_kind || 'personal', workspaceName: row.workspace_name || '', workspaceRole: row.workspace_role || '',
    membershipStatus: row.membership_status || '', createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}

function hydrateTimelineRef(store, row, { accessible = false } = {}) {
  const base = {
    id: row.ref_id, sequence: Number(row.sequence_no || 0), sourceKind: row.source_kind,
    sourceId: row.source_id, sourceConversationId: row.source_conversation_id || '', sourceMessageId: row.source_message_id || '',
    workspaceId: row.account_workspace_id || 'workspace_personal', workspaceKind: row.workspace_kind || 'personal',
    workspaceName: row.workspace_name || '', occurredAt: row.occurred_at || '', metadata: safeJsonParse(row.metadata_json, {}),
    accessState: accessible ? 'full' : 'redacted', canOpenSource: accessible && row.source_kind !== 'direct',
  };
  if (!accessible) return { ...base, role: 'system', content: '该工作空间的内容当前不可访问。', attachments: [] };
  if (row.source_kind === 'direct' || row.source_kind === 'task') {
    const message = store.getMessage?.(row.source_message_id || row.source_id);
    return message ? { ...base, role: message.role || '', content: message.content || '', attachments: store.listMessageAttachments?.(message.id) || [], message } : { ...base, role: 'system', content: '来源消息已不可用。', attachments: [] };
  }
  const table = row.source_kind === 'chat_group' ? 'chat_group_messages'
    : row.source_kind === 'collaboration_group' ? 'collaboration_group_messages'
      : row.source_kind === 'delegation' ? 'agent_delegation_workspace_messages' : '';
  const source = table ? get(store.db, `SELECT * FROM ${table} WHERE id=?`, [row.source_id]) : null;
  if (!source) return { ...base, role: 'system', content: '来源消息已不可用。', attachments: [] };
  return {
    ...base,
    role: source.role || (source.kind === 'system' ? 'system' : source.sender_user_id ? 'user' : 'assistant'),
    content: source.content || '', attachments: [], sourceMetadata: safeJsonParse(source.metadata_json, {}),
  };
}
