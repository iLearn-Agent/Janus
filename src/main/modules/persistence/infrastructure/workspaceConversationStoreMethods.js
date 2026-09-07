import { all, get, run } from '../../../db.js';
import { classifyPrivacy, memoryMergeDecision, privateMemoryMarker } from '../../../memory.js';
import { newId, nowIso, safeJsonParse, sha256Text } from '../../../utils.js';
import { normalizeProject, normalizeSession, normalizeInteractionMode, normalizeWorkspacePath, requestCodexThreadReset, normalizeGoalStatus, compareSessionsForDisplay, normalizeMemoryEntryContent, normalizeSearchText, textMatchesQuery, compactPreviewText, messageMetadataSearchText, flattenSearchValues, searchMatchExcerpt, normalizeMessage, normalizeConversation, normalizeTaskWorkspace, normalizeMessageAttachment, normalizeModelExecution, normalizeTaskRun, normalizeTaskNode, normalizeTaskEvent, normalizeTaskGraphRevision, normalizeCommunication, normalizeTaskRetrospective, normalizeMemoryEntry, normalizeMemoryAudit, normalizeEvolutionRun, normalizeArchive, normalizeSkillVersion, normalizeTypedMemory, normalizeHrReview, normalizeAgentEvolutionReview, normalizeGovernanceEvent, normalizePerformanceReview, normalizeSpecialistExperiment, normalizeWorkflowCredit } from '../domain/recordNormalizers.js';

function rebindRuntimeConversationReferences(db, sourceId = '', targetId = '', updatedAt = '', accountWorkspaceId = '') {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const source = db.prepare('SELECT group_id,task_workspace_id FROM conversations WHERE id=?').get(sourceId);
  const target = db.prepare('SELECT group_id,task_workspace_id FROM conversations WHERE id=?').get(targetId);
  if (!source || !target) throw new Error('Conversation rebind target is missing.');
  if (source.group_id && source.group_id !== target.group_id) throw new Error('Cannot merge conversations from different groups.');
  if (source.task_workspace_id && source.task_workspace_id !== target.task_workspace_id) {
    throw new Error('Cannot merge conversations from different task workspaces.');
  }
  const foreignWorkspace = db.prepare(`SELECT id FROM task_workspaces
    WHERE conversation_id=? AND conversation_id!=? LIMIT 1`).get(sourceId, targetId);
  if (foreignWorkspace) throw new Error('Conversation already belongs to another task workspace.');

  db.prepare(`UPDATE messages SET source_event_id='',updated_at=MAX(updated_at,?)
    WHERE conversation_id=? AND source_event_id!='' AND EXISTS (
      SELECT 1 FROM messages target_message
      WHERE target_message.conversation_id=? AND target_message.source_event_id=messages.source_event_id
        AND target_message.id!=messages.id
    )`).run(updatedAt, sourceId, targetId);
  for (const [tableName, columnName] of [
    ['sessions', 'conversation_id'], ['messages', 'conversation_id'], ['model_executions', 'conversation_id'],
    ['message_attachments', 'conversation_id'], ['conversation_aliases', 'conversation_id'],
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)) continue;
    db.prepare(`UPDATE "${tableName}" SET "${columnName}"=? WHERE "${columnName}"=?`).run(targetId, sourceId);
  }
  if (accountWorkspaceId) {
    for (const tableName of ['sessions', 'messages', 'model_executions', 'message_attachments']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName)) continue;
      db.prepare(`UPDATE "${tableName}" SET account_workspace_id=? WHERE conversation_id=?`).run(accountWorkspaceId, targetId);
    }
  }
  db.prepare('DELETE FROM conversations WHERE id=?').run(sourceId);
  db.prepare(`INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES(?,?,'runtime_conversation','task_workspace_runtime_rebind') ON CONFLICT(alias_id) DO UPDATE SET
    conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`).run(sourceId, targetId);
}

export function installWorkspaceConversationStoreMethods(prototype) {
  Object.assign(prototype, {
  createSession({
    id: requestedId = '',
    title,
    departmentId = '',
    agentId = '',
    agentInstanceId = '',
    projectId = '',
    workspaceRoot = '',
    interactionMode = '',
    memoryUseEnabled = true,
    memoryGenerateEnabled = false,
    userId = 'local_admin',
    accountWorkspaceId = '',
    reusePrimary = true,
    conversationRole: requestedConversationRole = '',
    status: requestedStatus = 'active',
  }) {
    const resolvedAccountWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: userId || 'local_admin', workspaceId: accountWorkspaceId }) || 'workspace_personal';
    const cleanInteractionMode = normalizeInteractionMode(interactionMode);
    let resolvedInstance = null;
    if (agentInstanceId) {
      const requestedInstance = this.getUserAgentInstance?.(agentInstanceId);
      const requestedFamilyId = agentId || requestedInstance?.agentFamilyId || '';
      resolvedInstance = this.requireRoutableUserAgent?.({
        userId: userId || 'local_admin',
        agentInstanceId,
        agentFamilyId: requestedFamilyId,
        allowSystem: requestedFamilyId === 'secretary_agent',
      })?.instance || null;
      if (!resolvedInstance) throw new Error('User Agent instance not found.');
      if (resolvedInstance.userId !== (userId || 'local_admin')) throw new Error('User Agent instance does not belong to the session user.');
      if (agentId && resolvedInstance.agentFamilyId !== agentId) throw new Error('User Agent instance does not match the session Agent family.');
    } else if (agentId && this.getAgentFamily?.(agentId)) {
      resolvedInstance = this.requireRoutableUserAgent?.({
        userId: userId || 'local_admin',
        agentFamilyId: agentId,
        allowSystem: agentId === 'secretary_agent',
      })?.instance || null;
    }
    const id = String(requestedId || '').trim() || newId('session');
    const existingSession = this.getSession(id);
    if (existingSession) {
      const sameIdentity = existingSession.userId === (userId || 'local_admin')
        && String(existingSession.agentInstanceId || '') === String(resolvedInstance?.id || '')
        && existingSession.accountWorkspaceId === resolvedAccountWorkspaceId
        && String(existingSession.projectId || '') === String(projectId || '')
        && normalizeWorkspacePath(existingSession.workspaceRoot || '') === normalizeWorkspacePath(workspaceRoot || '');
      if (!sameIdentity) throw new Error(`Session identity conflict: ${id}`);
      return existingSession;
    }
    const resolvedAgentInstanceId = resolvedInstance?.id || '';
    const primary = resolvedAgentInstanceId
      ? this.getPrimaryAgentSession?.({ userId: userId || 'local_admin', workspaceId: resolvedAccountWorkspaceId, agentInstanceId: resolvedAgentInstanceId })
      : null;
    if (primary && reusePrimary) {
      this.ensureConversationForSession?.(primary);
      const patch = {};
      if (String(primary.projectId || '') !== String(projectId || '')) patch.projectId = projectId || '';
      if (normalizeWorkspacePath(primary.workspaceRoot || '') !== normalizeWorkspacePath(workspaceRoot || '')) patch.workspaceRoot = workspaceRoot || '';
      if (normalizeInteractionMode(primary.interactionMode) !== cleanInteractionMode) patch.interactionMode = cleanInteractionMode;
      if (primary.memoryUseEnabled !== Boolean(memoryUseEnabled)) patch.memoryUseEnabled = Boolean(memoryUseEnabled);
      const resolvedPrimary = Object.keys(patch).length ? this.updateSession(primary.id, patch) : primary;
      this.stageAgentContextState?.({
        userId: userId || 'local_admin', agentInstanceId: resolvedAgentInstanceId,
        deviceId: this.contextDeviceId?.() || 'local', primarySessionId: resolvedPrimary.id,
        reason: 'primary_session_reused', workspaceId: resolvedAccountWorkspaceId,
      });
      this.recordAgentConversationBranch?.({ session: resolvedPrimary });
      return resolvedPrimary;
    }
    const allowedConversationRoles = new Set(['standard', 'primary', 'task_workspace', 'task_node']);
    const conversationRole = allowedConversationRoles.has(String(requestedConversationRole || ''))
      ? String(requestedConversationRole)
      : resolvedAgentInstanceId && !primary ? 'primary' : 'standard';
    const sessionStatus = ['active', 'archived'].includes(String(requestedStatus || ''))
      ? String(requestedStatus)
      : 'active';
    run(
      this.db,
      `INSERT INTO sessions (
        id, conversation_id, user_id, account_workspace_id, title, department_id, agent_id, agent_instance_id, project_id, workspace_root, interaction_mode,
        memory_use_enabled, memory_generate_enabled, conversation_role, write_state, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, id, userId || 'local_admin', resolvedAccountWorkspaceId, title || 'Untitled', departmentId, agentId, resolvedAgentInstanceId, projectId || '', workspaceRoot || '', cleanInteractionMode,
        memoryUseEnabled ? 1 : 0, memoryGenerateEnabled ? 1 : 0,
        conversationRole, 'writable', sessionStatus,
      ],
    );
    run(this.db, `INSERT OR IGNORE INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,project_id,workspace_root,status
    ) VALUES(?,?,'direct',?,?,?,?,?,?,'active')`, [
      id, resolvedAccountWorkspaceId, userId || 'local_admin', title || 'Untitled', agentId, resolvedAgentInstanceId,
      projectId || '', workspaceRoot || '',
    ]);
    if (resolvedAgentInstanceId && conversationRole === 'primary') {
      this.ensureWorkspaceAgentBinding?.({ workspaceId: resolvedAccountWorkspaceId, agentInstanceId: resolvedAgentInstanceId, ownerUserId: userId || 'local_admin' });
      const deviceId = this.contextDeviceId?.() || 'local';
      this.ensureDeviceContextState?.({ deviceId, userId: userId || 'local_admin', agentInstanceId: resolvedAgentInstanceId,
        workspaceId: resolvedAccountWorkspaceId });
      run(this.db, `UPDATE agent_device_context_state SET primary_session_id=?,updated_at=?
        WHERE device_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
        id, nowIso(), deviceId, resolvedAccountWorkspaceId, resolvedAgentInstanceId,
      ]);
      this.stageAgentContextState?.({
        userId: userId || 'local_admin', agentInstanceId: resolvedAgentInstanceId, deviceId,
        primarySessionId: id, reason: 'primary_session_created', workspaceId: resolvedAccountWorkspaceId,
      });
      this.recordAgentConversationBranch?.({ session: this.getSession(id) });
    }
    return this.getSession(id);
  },

  createProject({ title = '', workspaceRoot = '', userId = 'local_admin', accountWorkspaceId = '' } = {}) {
    const cleanWorkspace = String(workspaceRoot || '').trim();
    if (!cleanWorkspace) throw new Error('缺少项目工作区。');
    const cleanTitle = String(title || '').trim() || cleanWorkspace.split(/[\/]+/).filter(Boolean).pop() || 'Untitled project';
    const resolvedAccountWorkspaceId = this.resolveAccountWorkspaceId?.({ userId: userId || 'local_admin', workspaceId: accountWorkspaceId }) || 'workspace_personal';
    const id = newId('project');
    run(
      this.db,
      `INSERT INTO projects (id, user_id, account_workspace_id, title, workspace_root)
       VALUES (?, ?, ?, ?, ?)`,
      [id, userId || 'local_admin', resolvedAccountWorkspaceId, cleanTitle.slice(0, 120), cleanWorkspace],
    );
    const project = this.getProject(id);
    this.linkSessionsToProjectWorkspace(project);
    return project;
  },

  linkSessionsToProjectWorkspace(project = {}) {
    const projectId = String(project.id || '').trim();
    const workspaceRoot = String(project.workspaceRoot || project.workspace_root || '').trim();
    if (!projectId || !workspaceRoot) return 0;
    const result = run(
      this.db,
      `UPDATE sessions
       SET project_id = ?, workspace_root = ?, updated_at = ?
       WHERE status != 'deleted'
         AND user_id = ?
         AND account_workspace_id = ?
         AND (project_id = '' OR project_id IS NULL)
         AND workspace_root = ?`,
      [projectId, workspaceRoot, nowIso(), project.userId || project.user_id || 'local_admin', project.accountWorkspaceId || project.workspaceId || 'workspace_personal', workspaceRoot],
    );
    return Number(result?.changes || 0);
  },

  reconcileProjectSessionsByWorkspace({ user = null, accountWorkspaceId = '', allWorkspaces = false } = {}) {
    const where = ["status = 'active'", "workspace_root != ''"];
    const params = [];
    if (user) {
      where.push('user_id = ?');
      params.push(user.id);
      if (!allWorkspaces) {
        where.push('account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId: user.id, workspaceId: accountWorkspaceId }) || 'workspace_personal');
      }
    }
    const projects = all(
      this.db,
      `SELECT * FROM projects WHERE ${where.join(' AND ')}`,
      params,
    ).map(normalizeProject).filter(Boolean);
    let changed = 0;
    for (const project of projects) changed += this.linkSessionsToProjectWorkspace(project);
    return changed;
  },

  getProject(id) {
    return normalizeProject(get(this.db, 'SELECT * FROM projects WHERE id = ?', [id]));
  },

  listProjects({ user = null, accountWorkspaceId = '', allWorkspaces = false, includeArchived = false, limit = 80 } = {}) {
    const cleanLimit = Math.max(1, Math.min(200, Number(limit) || 80));
    const where = ["status != 'deleted'"];
    const params = [];
    if (user) {
      where.push('user_id = ?');
      params.push(user.id);
      if (!allWorkspaces) {
        where.push('account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId: user.id, workspaceId: accountWorkspaceId }) || 'workspace_personal');
      }
    }
    if (!includeArchived) where.push("status != 'archived'");
    params.push(cleanLimit);
    return all(
      this.db,
      `SELECT * FROM projects
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT ?`,
      params,
    ).map(normalizeProject).filter(Boolean);
  },

  removeProjectFromWorkspace(projectId) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const now = nowIso();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      run(this.db, "UPDATE projects SET status='deleted',updated_at=? WHERE id=?", [now, projectId]);
      const detached = run(this.db, `UPDATE sessions
        SET project_id='',workspace_root='',interaction_mode='',updated_at=?
        WHERE project_id=? AND status!='deleted'`, [now, projectId]);
      if (ownsTransaction) this.db.exec('COMMIT');
      return {
        project: this.getProject(projectId),
        detachedSessionCount: Number(detached?.changes || 0),
      };
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  updateProject(projectId, patch = {}) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const updates = [];
    const params = [];
    const now = nowIso();
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(patch, key);
    if (hasOwn('title')) {
      const title = String(patch.title || '').trim();
      if (!title) throw new Error('项目名称不能为空。');
      updates.push('title = ?');
      params.push(title.slice(0, 120));
    }
    if (hasOwn('archived')) {
      updates.push('status = ?');
      params.push(patch.archived ? 'archived' : 'active');
    }
    if (patch.deleted === true) {
      updates.push("status = 'deleted'");
    }
    if (!updates.length) return project;
    updates.push('updated_at = ?');
    params.push(now, projectId);
    run(this.db, `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, params);
    if (hasOwn('archived')) {
      run(
        this.db,
        `UPDATE sessions SET status = ?, pinned_at = CASE WHEN ? = 'archived' THEN '' ELSE pinned_at END, updated_at = ? WHERE project_id = ? AND status != 'deleted'`,
        [patch.archived ? 'archived' : 'active', patch.archived ? 'archived' : 'active', now, projectId],
      );
    }
    if (patch.deleted === true) {
      run(this.db, `UPDATE sessions SET status = 'deleted', pinned_at = '', updated_at = ? WHERE project_id = ?`, [now, projectId]);
    }
    return this.getProject(projectId);
  },

  getSession(id) {
    return normalizeSession(get(this.db, 'SELECT * FROM sessions WHERE id = ?', [id]));
  },

  getConversation(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return null;
    const canonicalId = get(this.db, 'SELECT conversation_id FROM conversation_aliases WHERE alias_id=?', [cleanId])?.conversation_id || cleanId;
    return normalizeConversation(get(this.db, 'SELECT * FROM conversations WHERE id=?', [canonicalId]));
  },

  ensureConversationForSession(sessionOrId) {
    const session = typeof sessionOrId === 'string' ? this.getSession(sessionOrId) : sessionOrId;
    if (!session?.id) return null;
    const conversationId = String(session.conversationId || session.id).trim();
    run(this.db, `INSERT OR IGNORE INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,project_id,workspace_root,status,created_at,updated_at
    ) VALUES(?,?,'direct',?,?,?,?,?,?,?,?,?)`, [
      conversationId, session.accountWorkspaceId || 'workspace_personal', session.userId || '', session.title || 'Untitled',
      session.agentId || '', session.agentInstanceId || '', session.projectId || '', session.workspaceRoot || '',
      session.status || 'active', session.createdAt || nowIso(), session.updatedAt || nowIso(),
    ]);
    run(this.db, 'UPDATE sessions SET conversation_id=? WHERE id=? AND conversation_id!=?', [conversationId, session.id, conversationId]);
    run(this.db, `INSERT OR IGNORE INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
      VALUES(?,?,'session','runtime_binding')`, [session.id, conversationId]);
    return this.getConversation(conversationId);
  },

  getTaskWorkspace(id) {
    return normalizeTaskWorkspace(get(this.db, 'SELECT * FROM task_workspaces WHERE id=?', [id]));
  },

  getTaskWorkspaceForDelegation({ delegationId = '', ownerUserId = '' } = {}) {
    return normalizeTaskWorkspace(get(this.db, `SELECT * FROM task_workspaces
      WHERE delegation_id=? AND owner_user_id=?`, [delegationId, ownerUserId]));
  },

  ensureTaskWorkspaceConversation({ delegationId = '', ownerUserId = '', sessionId = '', taskRunId = '', groupId = '', workspaceRoot = '', workspaceEpoch = '', metadata = {} } = {}) {
    const session = this.getSession(sessionId);
    if (!delegationId || !ownerUserId || !session) return null;
    const taskWorkspaceId = `task_workspace:${delegationId}:${ownerUserId}`;
    const now = nowIso();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const requestedConversation = this.ensureConversationForSession(session);
      const existingWorkspace = get(this.db, `SELECT * FROM task_workspaces
        WHERE delegation_id=? AND owner_user_id=?`, [delegationId, ownerUserId]);
      const existingWorkspaceConversation = existingWorkspace?.conversation_id
        ? this.getConversation(existingWorkspace.conversation_id)
        : null;
      const boundConversation = get(this.db, `SELECT * FROM conversations
        WHERE task_workspace_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,status='active' DESC,created_at,id LIMIT 1`, [
        taskWorkspaceId, existingWorkspace?.conversation_id || '',
      ]);
      const canonicalConversationId = String(existingWorkspaceConversation?.id || boundConversation?.id || requestedConversation.id).trim();
      const canonicalConversation = this.getConversation(canonicalConversationId);
      if (!canonicalConversation) throw new Error('Task workspace conversation is missing.');
      const canonicalAccountWorkspaceId = String(existingWorkspace?.account_workspace_id
        || canonicalConversation.accountWorkspaceId || session.accountWorkspaceId || 'workspace_personal');

      if (requestedConversation.id !== canonicalConversationId) {
        rebindRuntimeConversationReferences(
          this.db, requestedConversation.id, canonicalConversationId, now, canonicalAccountWorkspaceId,
        );
      }
      run(this.db, `UPDATE conversations SET account_workspace_id=?,conversation_kind='task_workspace',task_workspace_id=?,
        group_id=?,workspace_root=?,status=CASE WHEN status='deleted' THEN 'active' ELSE status END,updated_at=? WHERE id=?`, [
        canonicalAccountWorkspaceId, taskWorkspaceId,
        groupId || existingWorkspace?.group_id || '', workspaceRoot || existingWorkspace?.workspace_root || session.workspaceRoot || '',
        now, canonicalConversationId,
      ]);
      run(this.db, `UPDATE sessions SET conversation_id=?,account_workspace_id=?,conversation_role=CASE
        WHEN conversation_role='history' OR write_state='read_only' THEN conversation_role ELSE 'task_workspace' END,
        superseded_by_session_id=CASE WHEN conversation_role='history' OR write_state='read_only' THEN superseded_by_session_id ELSE '' END,
        updated_at=? WHERE id=?`, [canonicalConversationId, canonicalAccountWorkspaceId, now, session.id]);
      run(this.db, `INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
        VALUES(?,?,'session','task_workspace_runtime_binding') ON CONFLICT(alias_id) DO UPDATE SET
        conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`, [session.id, canonicalConversationId]);
      run(this.db, `INSERT INTO task_workspaces(
        id,account_workspace_id,delegation_id,task_run_id,group_id,owner_user_id,conversation_id,workspace_root,
        workspace_epoch,visibility,status,metadata_json,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'private','active',?,?) ON CONFLICT(delegation_id,owner_user_id) DO UPDATE SET
        task_run_id=excluded.task_run_id,group_id=excluded.group_id,conversation_id=excluded.conversation_id,
        workspace_root=excluded.workspace_root,workspace_epoch=excluded.workspace_epoch,metadata_json=excluded.metadata_json,
        status='active',updated_at=excluded.updated_at`, [
        taskWorkspaceId, canonicalAccountWorkspaceId,
        delegationId, taskRunId || existingWorkspace?.task_run_id || '', groupId || existingWorkspace?.group_id || '', ownerUserId,
        canonicalConversationId, workspaceRoot || existingWorkspace?.workspace_root || session.workspaceRoot || '',
        workspaceEpoch || existingWorkspace?.workspace_epoch || '', JSON.stringify(metadata || {}), now,
      ]);
      run(this.db, `UPDATE messages SET task_workspace_id=? WHERE conversation_id=? AND task_workspace_id=''`, [taskWorkspaceId, canonicalConversationId]);
      if (ownsTransaction) this.db.exec('COMMIT');
      return this.getTaskWorkspace(taskWorkspaceId);
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  updateSession(sessionId, patch = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (session.readOnly && patch.allowReadOnlyMutation !== true) throw new Error('Historical session is read-only.');
    const updates = [];
    const params = [];
    const now = nowIso();
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(patch, key);

    if (hasOwn('title')) {
      const title = String(patch.title || '').trim();
      if (!title) throw new Error('会话标题不能为空。');
      updates.push('title = ?');
      params.push(title.slice(0, 120));
    }

    if (hasOwn('projectId')) {
      updates.push('project_id = ?');
      const nextProjectId = String(patch.projectId || '').trim();
      params.push(nextProjectId);
      if (!session.agentInstanceId && nextProjectId !== String(session.projectId || '')) requestCodexThreadReset(updates);
    }

    if (hasOwn('workspaceRoot')) {
      updates.push('workspace_root = ?');
      const nextWorkspaceRoot = String(patch.workspaceRoot || '').trim();
      params.push(nextWorkspaceRoot);
      if (!session.agentInstanceId && normalizeWorkspacePath(nextWorkspaceRoot) !== normalizeWorkspacePath(session.workspaceRoot || '')) {
        requestCodexThreadReset(updates);
      }
    }

    if (hasOwn('interactionMode')) {
      updates.push('interaction_mode = ?');
      params.push(normalizeInteractionMode(patch.interactionMode));
    }

    if (hasOwn('memoryUseEnabled')) {
      updates.push('memory_use_enabled = ?');
      params.push(patch.memoryUseEnabled ? 1 : 0);
      if (!session.agentInstanceId && session.memoryUseEnabled !== Boolean(patch.memoryUseEnabled)) {
        requestCodexThreadReset(updates);
      }
    }

    if (hasOwn('memoryGenerateEnabled')) {
      updates.push('memory_generate_enabled = ?');
      params.push(patch.memoryGenerateEnabled ? 1 : 0);
    }

    if (hasOwn('goal')) {
      const goal = patch.goal && typeof patch.goal === 'object' ? patch.goal : {};
      updates.push('goal_objective = ?', 'goal_status = ?', 'goal_tokens_used = ?', 'goal_token_budget = ?', 'goal_time_used_seconds = ?');
      params.push(
        String(goal.objective || '').slice(0, 4000),
        normalizeGoalStatus(goal.status),
        Math.max(0, Number(goal.tokensUsed || goal.tokens_used || 0) || 0),
        0,
        Math.max(0, Number(goal.timeUsedSeconds || goal.time_used_seconds || 0) || 0),
      );
    }

    if (patch.deleted === true) {
      updates.push("status = 'deleted'");
      updates.push("pinned_at = ''");
    } else if (hasOwn('archived')) {
      updates.push('status = ?');
      params.push(patch.archived ? 'archived' : 'active');
    } else if (hasOwn('status')) {
      const status = ['active', 'archived', 'deleted'].includes(patch.status) ? patch.status : 'active';
      updates.push('status = ?');
      params.push(status);
      if (status === 'deleted') updates.push("pinned_at = ''");
    }

    if (hasOwn('pinned')) {
      updates.push('pinned_at = ?');
      params.push(patch.pinned ? now : '');
    }

    if (!updates.length) return session;
    updates.push('updated_at = ?');
    params.push(now, sessionId);
    run(this.db, `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`, params);
    const updated = this.getSession(sessionId);
    const conversation = this.ensureConversationForSession(updated);
    if (conversation) {
      run(this.db, `UPDATE conversations SET title=?,project_id=?,workspace_root=?,status=?,updated_at=? WHERE id=?`, [
        updated.title || conversation.title, updated.projectId || '', updated.workspaceRoot || '', updated.status || 'active', now, conversation.id,
      ]);
    }
    return updated;
  },

  renameSession(sessionId, title) {
    return this.updateSession(sessionId, { title });
  },

  setSessionPinned(sessionId, pinned = true) {
    return this.updateSession(sessionId, { pinned });
  },

  setSessionArchived(sessionId, archived = true) {
    return this.updateSession(sessionId, { archived });
  },

  deleteSession(sessionId) {
    return this.updateSession(sessionId, { deleted: true });
  },

  listSessions({ limit = 80, user = null, accountWorkspaceId = '', allWorkspaces = false, includeArchived = false } = {}) {
    const cleanLimit = Math.max(1, Math.min(200, Number(limit) || 80));
    const where = ["s.status != 'deleted'", "s.conversation_role != 'task_node'", `NOT (
      s.agent_instance_id!='' AND s.conversation_role='history' AND s.write_state='read_only'
      AND s.department_id NOT IN ('agent_delegation','collaboration')
    )`];
    const params = [];
    if (user) {
      where.push('s.user_id = ?');
      params.push(user.id);
      if (!allWorkspaces) {
        where.push('s.account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId: user.id, workspaceId: accountWorkspaceId }) || 'workspace_personal');
      }
    }
    if (!includeArchived) where.push("s.status != 'archived'");
    params.push(cleanLimit);
    const sessions = all(
      this.db,
      `SELECT s.*,
         latest_message.content AS last_message,
         latest_message.role AS last_message_role,
         latest_message.created_at AS last_message_at
       FROM sessions s
       LEFT JOIN messages latest_message ON latest_message.id = (
         SELECT m.id FROM messages m
         WHERE m.session_id = s.id
           AND m.visible = 1
           AND m.role IN ('user','assistant')
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 1
       )
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN s.pinned_at != '' THEN 0 ELSE 1 END,
         s.pinned_at DESC,
         s.updated_at DESC
       LIMIT ?`,
      params,
    ).map(normalizeSession);
    const deliveryCounts = this.unreadAgentDeliveryCounts?.({ userId: user?.id || '' }) || {};
    return sessions.map((session) => ({
      ...session,
      unreadDeliveryCount: Number(deliveryCounts[session.id] || 0),
      unreadCount: Number(deliveryCounts[session.id] || 0),
    }));
  },

  searchSessions({ query = '', limit = 50, user = null, accountWorkspaceId = '', allWorkspaces = false, transcriptReader = null } = {}) {
    const cleanLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const needle = normalizeSearchText(query);
    if (!needle) return this.listSessions({ limit: cleanLimit, user, accountWorkspaceId, allWorkspaces });

    const where = ["s.status != 'deleted'", "s.conversation_role != 'task_node'"];
    const params = [];
    if (user) {
      where.push('s.user_id = ?');
      params.push(user.id);
      if (!allWorkspaces) {
        where.push('s.account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId: user.id, workspaceId: accountWorkspaceId }) || 'workspace_personal');
      }
    }
    const sessionRows = all(
      this.db,
      `SELECT s.*
       FROM sessions s
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN s.pinned_at != '' THEN 0 ELSE 1 END,
         s.pinned_at DESC,
         s.updated_at DESC`,
      params,
    );
    const sessions = sessionRows.map(normalizeSession).filter(Boolean);
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const matches = new Map();

    const addMatch = (session, match) => {
      if (!session || matches.has(session.id)) return;
      matches.set(session.id, {
        ...session,
        matchRole: match.role || '',
        matchExcerpt: match.excerpt || '',
        matchSource: match.source || '',
        matchCreatedAt: match.createdAt || '',
        match_role: match.role || '',
        match_excerpt: match.excerpt || '',
        match_source: match.source || '',
        match_created_at: match.createdAt || '',
      });
    };

    for (const session of sessions) {
      const searchable = [session.title, session.departmentId, session.agentId].filter(Boolean).join(' ');
      if (!textMatchesQuery(searchable, needle)) continue;
      addMatch(session, {
        role: 'title',
        excerpt: searchMatchExcerpt(session.title || searchable, needle, 140),
        source: 'session',
        createdAt: session.updatedAt || session.createdAt || '',
      });
    }

    const messageRows = all(
      this.db,
      `SELECT m.session_id, m.role, m.content, m.metadata_json, m.created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE ${where.join(' AND ')}
         AND m.visible = 1
         AND m.role IN ('user', 'assistant')
       ORDER BY s.updated_at DESC, m.created_at ASC`,
      params,
    );
    for (const row of messageRows) {
      if (matches.size >= cleanLimit && matches.has(row.session_id)) continue;
      const session = sessionById.get(row.session_id);
      if (!session || matches.has(session.id)) continue;
      const metadataText = messageMetadataSearchText(row.metadata_json);
      const searchableText = [row.content, metadataText].filter(Boolean).join(' ');
      if (!textMatchesQuery(searchableText, needle)) continue;
      addMatch(session, {
        role: row.role,
        excerpt: searchMatchExcerpt(textMatchesQuery(row.content, needle) ? row.content : searchableText, needle, 160),
        source: 'message',
        createdAt: row.created_at || '',
      });
    }

    if (typeof transcriptReader === 'function' && matches.size < cleanLimit) {
      for (const session of sessions) {
        if (matches.size >= cleanLimit) break;
        if (matches.has(session.id)) continue;
        let transcriptMessages = [];
        try {
          transcriptMessages = transcriptReader(session) || [];
        } catch {
          transcriptMessages = [];
        }
        for (const message of transcriptMessages) {
          if (!message || !textMatchesQuery(message.content, needle)) continue;
          addMatch(session, {
            role: message.role || '',
            excerpt: searchMatchExcerpt(message.content, needle, 160),
            source: 'codex_transcript',
            createdAt: message.created_at || message.createdAt || '',
          });
          break;
        }
      }
    }

    return Array.from(matches.values())
      .sort(compareSessionsForDisplay)
      .slice(0, cleanLimit);
  },

  updateSessionThread(sessionId, threadId) {
    const session = this.getSession(sessionId);
    if (session?.readOnly) throw new Error('Historical session is read-only.');
    run(
      this.db,
      `UPDATE sessions SET codex_thread_id = ?, updated_at = ? WHERE id = ?`,
      [threadId || '', nowIso(), sessionId],
    );
  },

  touchSession(sessionId) {
    run(this.db, 'UPDATE sessions SET updated_at = ? WHERE id = ?', [nowIso(), sessionId]);
  },

  addMessage({
    sessionId = '',
    conversationId = '',
    memoryId = '',
    taskWorkspaceId = '',
    senderUserId = '',
    sourceEventId = '',
    sourceMessageId = '',
    taskRunId = '',
    taskNodeId = '',
    role,
    content,
    agentId = '',
    agentInstanceId = '',
    departmentId = '',
    contextSpaceId = '',
    deviceId = '',
    visible = true,
    metadata = {},
  }) {
    const id = newId('msg');
    const session = sessionId ? this.getSession(sessionId) : null;
    const conversation = session ? this.ensureConversationForSession(session) : this.getConversation(conversationId);
    const resolvedConversationId = String(conversationId || conversation?.id || session?.conversationId || sessionId || '').trim();
    const resolvedAccountWorkspaceId = session?.accountWorkspaceId || session?.workspaceId || 'workspace_personal';
    if (session?.readOnly) throw new Error('Historical session is read-only.');
    const requestedAgentInstanceId = String(agentInstanceId || session?.agentInstanceId || '').trim();
    const sessionAgentInstanceId = String(session?.agentInstanceId || '').trim();
    const requestedCanonicalAgentInstanceId = requestedAgentInstanceId
      ? this.resolveCanonicalAgentInstanceId?.(requestedAgentInstanceId) || requestedAgentInstanceId
      : '';
    const sessionCanonicalAgentInstanceId = sessionAgentInstanceId
      ? this.resolveCanonicalAgentInstanceId?.(sessionAgentInstanceId) || sessionAgentInstanceId
      : '';
    if (sessionAgentInstanceId
      && requestedCanonicalAgentInstanceId !== sessionCanonicalAgentInstanceId) {
      throw new Error('Message Agent instance does not match the session Agent instance.');
    }
    const resolvedAgentInstanceId = sessionAgentInstanceId || requestedCanonicalAgentInstanceId;
    if (resolvedAgentInstanceId) {
      const instance = this.getUserAgentInstance?.(resolvedAgentInstanceId);
      if (!instance || (session?.userId && instance.userId !== session.userId)
        || (agentId && instance.agentFamilyId !== agentId)) {
        throw new Error('Message Agent identity does not match its Agent instance.');
      }
    }
    const resolvedDeviceId = deviceId || this.contextDeviceId?.() || 'local';
    const conversationContext = resolvedAgentInstanceId && session?.userId
      ? this.getAgentConversationContextSpace?.({
          deviceId: resolvedDeviceId,
          userId: session.userId,
          agentInstanceId: resolvedAgentInstanceId,
          workspaceId: resolvedAccountWorkspaceId,
        })
      : null;
    const contextState = resolvedAgentInstanceId && session?.userId
      ? this.getDeviceContextState?.({
          deviceId: resolvedDeviceId,
          userId: session.userId,
          agentInstanceId: resolvedAgentInstanceId,
          workspaceId: resolvedAccountWorkspaceId,
        })
      : null;
    const activeContext = contextState?.activeContextSpaceId
      ? this.getAgentContextSpace?.(contextState.activeContextSpaceId)
      : null;
    const automaticContextSpaceId = activeContext && ['task', 'relationship'].includes(activeContext.contextKind)
      ? activeContext.id
      : conversationContext?.id || '';
    const resolvedContextSpaceId = contextSpaceId || automaticContextSpaceId;
    const contextSpace = resolvedContextSpaceId ? this.getAgentContextSpace?.(resolvedContextSpaceId) : null;
    const resolvedMemoryId = String(memoryId || contextSpace?.memoryDocumentId || '').trim();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      run(
        this.db,
        `INSERT INTO messages (
          id, account_workspace_id, conversation_id, session_id, memory_id, task_workspace_id,
          sender_user_id, source_event_id, source_message_id, task_run_id, task_node_id, role, content,
          agent_id, agent_instance_id, department_id, context_space_id, visible, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, resolvedAccountWorkspaceId, resolvedConversationId, sessionId, resolvedMemoryId, taskWorkspaceId,
          senderUserId || session?.userId || '', sourceEventId, sourceMessageId, taskRunId, taskNodeId, role, content,
          agentId, resolvedAgentInstanceId, departmentId, resolvedContextSpaceId, visible ? 1 : 0, JSON.stringify(metadata)],
      );
      this.syncMessageAttachments?.(id, metadata);
      if (sessionId) this.touchSession(sessionId);
      recordMessageOutbox(this, this.getMessage(id));
      this.indexAgentConversationMessage?.(this.getMessage(id));
      if (ownsTransaction) this.db.exec('COMMIT');
      return this.getMessage(id);
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  beginModelExecution({
    id = newId('model_exec'),
    userId = '',
    projectId = '',
    conversationId = '',
    requestMessageId = '',
    responseMessageId = '',
    taskRunId = '',
    taskNodeId = '',
    departmentId = '',
    agentId = '',
    agentInstanceId = '',
    agentVersionId = '',
    personalSkillVersionId = '',
    agentRole = 'agent',
    executionKind = 'chat',
    providerId = '',
    requestedModel = '',
    effectiveModel = '',
    reasoningEffort = '',
    modelSource = 'config_default',
    codexThreadId = '',
    codexTurnId = '',
    skillHash = '',
    memoryHash = '',
    memoryManifestHash = '',
    organizationVersion = '',
    status = 'running',
    metadata = {},
    accountWorkspaceId = '',
  } = {}) {
    const startedAt = nowIso();
    const relatedSession = conversationId ? this.getSession(conversationId) : null;
    const relatedTask = taskRunId ? this.getTaskRun?.(taskRunId) : null;
    const resolvedAccountWorkspaceId = accountWorkspaceId || relatedSession?.accountWorkspaceId || relatedTask?.accountWorkspaceId || 'workspace_personal';
    run(
      this.db,
      `INSERT INTO model_executions (
        id, user_id, account_workspace_id, project_id, conversation_id, request_message_id, response_message_id,
        task_run_id, task_node_id, department_id, agent_id, agent_instance_id,
        agent_version_id, personal_skill_version_id, agent_role, execution_kind,
        provider_id, requested_model, effective_model, reasoning_effort, model_source,
        codex_thread_id, codex_turn_id, skill_hash, memory_hash, memory_manifest_hash, organization_version,
        status, metadata_json, started_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, resolvedAccountWorkspaceId, projectId, conversationId, requestMessageId, responseMessageId,
        taskRunId, taskNodeId, departmentId, agentId, agentInstanceId,
        agentVersionId, personalSkillVersionId, agentRole, executionKind,
        providerId, requestedModel, effectiveModel, reasoningEffort, modelSource,
        codexThreadId, codexTurnId, skillHash, memoryHash, memoryManifestHash, organizationVersion,
        status, JSON.stringify(metadata || {}), startedAt, startedAt,
      ],
    );
    return this.getModelExecution(id);
  },

  updateModelExecution(id, patch = {}) {
    const before = this.getModelExecution(id);
    const fields = [];
    const params = [];
    const mappings = {
      responseMessageId: 'response_message_id',
      codexThreadId: 'codex_thread_id',
      codexTurnId: 'codex_turn_id',
      status: 'status',
      errorText: 'error_text',
      completedAt: 'completed_at',
    };
    for (const [key, column] of Object.entries(mappings)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      fields.push(`${column} = ?`);
      params.push(String(patch[key] || ''));
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'metadata')) {
      fields.push('metadata_json = ?');
      params.push(JSON.stringify(patch.metadata || {}));
    }
    if (!fields.length) return this.getModelExecution(id);
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      run(this.db, `UPDATE model_executions SET ${fields.join(', ')} WHERE id = ?`, params);
      const after = this.getModelExecution(id);
      if (after && terminalModelExecutionStatus(after.status) && !terminalModelExecutionStatus(before?.status)) {
        recordModelExecutionOutbox(this, after);
      }
      if (ownsTransaction) this.db.exec('COMMIT');
      return after;
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  completeModelExecution(id, { status = 'completed', errorText = '', responseMessageId = '', codexThreadId = '', codexTurnId = '', metadata = null } = {}) {
    return this.updateModelExecution(id, {
      status,
      errorText,
      responseMessageId,
      codexThreadId,
      codexTurnId,
      completedAt: nowIso(),
      ...(metadata ? { metadata } : {}),
    });
  },

  getModelExecution(id) {
    return normalizeModelExecution(get(this.db, 'SELECT * FROM model_executions WHERE id = ?', [id]));
  },

  listModelExecutionsForConversation(conversationId) {
    return all(
      this.db,
      'SELECT * FROM model_executions WHERE conversation_id = ? ORDER BY started_at ASC, id ASC',
      [conversationId],
    ).map(normalizeModelExecution);
  },

  listModelExecutionsForTask(taskRunId) {
    return all(
      this.db,
      'SELECT * FROM model_executions WHERE task_run_id = ? ORDER BY started_at ASC, id ASC',
      [taskRunId],
    ).map(normalizeModelExecution);
  },

  getMessage(id) {
    return withStoredAttachments(this, normalizeMessage(get(this.db, 'SELECT * FROM messages WHERE id = ?', [id])));
  },

  updateMessage(id, { content, metadata } = {}) {
    const current = this.getMessage(id);
    if (!current) return null;
    const fields = [];
    const params = [];
    if (content !== undefined) {
      fields.push('content = ?');
      params.push(String(content || ''));
    }
    if (metadata !== undefined) {
      fields.push('metadata_json = ?');
      params.push(JSON.stringify(metadata || {}));
    }
    if (!fields.length) return current;
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      params.push(id);
      run(this.db, `UPDATE messages SET ${fields.join(', ')} WHERE id = ?`, params);
      if (current.sessionId) this.touchSession(current.sessionId);
      const updated = this.getMessage(id);
      if (metadata !== undefined) this.syncMessageAttachments?.(id, metadata);
      if (content !== undefined && String(content || '') !== String(current.content || '')) recordMessageOutbox(this, updated);
      if (ownsTransaction) this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  supersedeLatestUserTurn({ sessionId = '', messageId = '', commandId = '' } = {}) {
    const session = this.getSession(sessionId);
    const target = this.getMessage(messageId);
    if (!session || !target || target.sessionId !== session.id || target.role !== 'user' || target.visible === false) {
      throw new Error('要重新编辑的消息已不可用。');
    }
    if (session.readOnly || session.writeState === 'read_only') throw new Error('只读历史会话不能重新编辑。');
    const visibleMessages = this.listMessages(session.id, { includeAllContexts: true });
    const latestUser = [...visibleMessages].reverse().find((message) => message.role === 'user');
    if (latestUser?.id !== target.id) throw new Error('只能重新编辑当前会话中最近发送的一条消息。');
    const targetIndex = visibleMessages.findIndex((message) => message.id === target.id);
    const superseded = visibleMessages.slice(targetIndex);
    const rewriteId = String(commandId || '').trim() || newId('message_rewrite');
    const rewrittenAt = nowIso();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const message of superseded) {
        run(this.db, `UPDATE messages SET visible=0,metadata_json=?,updated_at=? WHERE id=?`, [JSON.stringify({
          ...(message.metadata || {}),
          supersededByRewrite: {
            commandId: rewriteId,
            sourceMessageId: target.id,
            rewrittenAt,
          },
        }), rewrittenAt, message.id]);
      }
      const identityColumn = session.conversationId ? 'conversation_id' : 'session_id';
      const identityValue = session.conversationId || session.id;
      for (const row of all(this.db, `SELECT id,metadata_json FROM messages WHERE ${identityColumn}=? AND visible=0`, [identityValue])) {
        const metadata = safeJsonParse(row.metadata_json, {});
        if (!metadata.contextCompressionSummary || metadata.supersededByRewrite) continue;
        run(this.db, 'UPDATE messages SET metadata_json=?,updated_at=? WHERE id=?', [JSON.stringify({
          ...metadata,
          supersededByRewrite: { commandId: rewriteId, sourceMessageId: target.id, rewrittenAt },
        }), rewrittenAt, row.id]);
      }
      const supersededIds = superseded.map((message) => message.id);
      for (const execution of all(this.db, `SELECT * FROM model_executions WHERE conversation_id IN (?,?)`, [session.id, session.conversationId || session.id])) {
        if (!supersededIds.includes(execution.request_message_id) && !supersededIds.includes(execution.response_message_id)) continue;
        const metadata = safeJsonParse(execution.metadata_json, {});
        const running = !['completed', 'failed', 'cancelled'].includes(String(execution.status || ''));
        run(this.db, `UPDATE model_executions SET status=?,completed_at=CASE WHEN ? THEN ? ELSE completed_at END,
          metadata_json=?,updated_at=? WHERE id=?`, [running ? 'cancelled' : execution.status, running ? 1 : 0, rewrittenAt,
          JSON.stringify({ ...metadata, supersededByRewrite: { commandId: rewriteId, sourceMessageId: target.id, rewrittenAt } }),
          rewrittenAt, execution.id]);
      }
      run(this.db, `UPDATE sessions SET codex_thread_id='',updated_at=? WHERE id=?`, [rewrittenAt, session.id]);
      run(this.db, `UPDATE chat_context_states SET context_epoch=context_epoch+1,reset_after_message_id='',reset_after_created_at='',
        last_execution_id='',last_input_tokens=0,provider_compaction_detected=0,state_revision=state_revision+1,
        last_command_id=?,sync_status='pending',updated_at=? WHERE session_id=?`, [rewriteId, rewrittenAt, session.id]);
      if (session.agentInstanceId) {
        run(this.db, `UPDATE agent_conversation_branch_state SET rebuild_required=1,thread_generation=thread_generation+1,updated_at=?
          WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=?`, [rewrittenAt, session.userId,
          session.accountWorkspaceId || 'workspace_personal', session.agentInstanceId]);
      }
      if (ownsTransaction) this.db.exec('COMMIT');
      return {
        ok: true,
        commandId: rewriteId,
        sourceMessage: target,
        supersededMessageIds: supersededIds,
        messages: this.listMessages(session.id, { includeAllContexts: true }),
      };
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  syncMessageAttachments(messageId, metadata = {}) {
    const message = this.getMessage(messageId);
    if (!message) return [];
    const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
    const fileReferences = Array.isArray(metadata?.fileReferences) ? metadata.fileReferences : [];
    run(this.db, `DELETE FROM message_attachments WHERE message_id=? AND relation_type IN ('attachment','project_reference')`, [messageId]);
    for (const attachment of attachments) {
      const name = String(attachment?.name || attachment?.filename || '').trim();
      const fileId = String(attachment?.fileId || attachment?.file_id || attachment?.id || '').trim();
      if (!name && !fileId) continue;
      const id = `message_attachment_${sha256Text(`${messageId}\nattachment\n${fileId}\n${name}`).slice(0, 40)}`;
      run(this.db, `INSERT OR REPLACE INTO message_attachments(
        id,account_workspace_id,conversation_id,message_id,task_workspace_id,file_id,relation_type,name,
        content_type,size_bytes,sha256,local_path,remote_file_id,metadata_json,updated_at
      ) VALUES(?,?,?,?,?,?,'attachment',?,?,?,?,?,?,?,?)`, [
        id, message.accountWorkspaceId || 'workspace_personal', message.conversationId || message.sessionId || '', message.id,
        message.taskWorkspaceId || '', fileId, name,
        attachment?.contentType || attachment?.content_type || attachment?.type || '',
        Math.max(0, Number(attachment?.sizeBytes || attachment?.size_bytes || attachment?.size || 0) || 0),
        attachment?.sha256 || '', attachment?.path || attachment?.localPath || attachment?.local_path || '',
        attachment?.remoteFileId || attachment?.remote_file_id || '', JSON.stringify(attachment || {}), nowIso(),
      ]);
    }
    for (const reference of fileReferences) {
      const relativePath = String(reference?.relativePath || reference?.relative_path || '').trim().replaceAll('\\', '/');
      const projectId = String(reference?.projectId || reference?.project_id || '').trim();
      const referenceId = String(reference?.referenceId || reference?.reference_id || reference?.id || '').trim();
      if (!relativePath || !projectId || !referenceId) continue;
      const id = `message_project_reference_${sha256Text(`${messageId}\n${projectId}\n${relativePath}\n${referenceId}`).slice(0, 40)}`;
      const safeMetadata = {
        referenceId,
        referenceKind: reference?.referenceKind || reference?.reference_kind || 'file',
        projectId,
        relativePath,
        contentHash: reference?.contentHash || reference?.content_hash || reference?.sha256 || '',
        modifiedAt: reference?.modifiedAt || reference?.modified_at || '',
        source: 'picker',
        memoryId: reference?.memoryId || reference?.memory_id || message.memoryId || '',
        contextSpaceId: reference?.contextSpaceId || reference?.context_space_id || message.contextSpaceId || '',
      };
      run(this.db, `INSERT OR REPLACE INTO message_attachments(
        id,account_workspace_id,conversation_id,message_id,task_workspace_id,file_id,relation_type,name,
        content_type,size_bytes,sha256,local_path,remote_file_id,metadata_json,updated_at
      ) VALUES(?,?,?,?,?,?,'project_reference',?,?,?,?,?,'',?,?)`, [
        id, message.accountWorkspaceId || 'workspace_personal', message.conversationId || message.sessionId || '', message.id,
        message.taskWorkspaceId || '', referenceId, reference?.name || relativePath.split('/').at(-1) || relativePath,
        reference?.contentType || reference?.content_type || '', Math.max(0, Number(reference?.sizeBytes || reference?.size_bytes || 0) || 0),
        safeMetadata.contentHash, '', JSON.stringify(safeMetadata), nowIso(),
      ]);
    }
    return this.listMessageAttachments(messageId);
  },

  listMessageAttachments(messageId) {
    return all(this.db, `SELECT * FROM message_attachments WHERE message_id=? ORDER BY created_at,id`, [messageId])
      .map(normalizeMessageAttachment);
  },

  listMessages(sessionId, { contextSpaceId = '', includeAllContexts = true } = {}) {
    const session = this.getSession(sessionId);
    const conversationId = String(session?.conversationId || sessionId || '').trim();
    const where = ['((conversation_id = ? AND conversation_id != \'\') OR (conversation_id = \'\' AND session_id = ?))', 'visible = 1'];
    const params = [conversationId, sessionId];
    if (!includeAllContexts && contextSpaceId) {
      const memoryId = String(this.getAgentContextSpace?.(contextSpaceId)?.memoryDocumentId || '').trim();
      if (memoryId) {
        where.push('(memory_id = ? OR (memory_id = \'\' AND context_space_id = ?))');
        params.push(memoryId, contextSpaceId);
      } else {
        where.push('context_space_id = ?');
        params.push(contextSpaceId);
      }
    }
    return all(
      this.db,
      `SELECT * FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC`,
      params,
    ).map(normalizeMessage).map((message) => withStoredAttachments(this, message));
  },

  listMessagePage(sessionId, { before = null, limit = 80 } = {}) {
    const session = this.getSession(sessionId);
    const conversationId = String(session?.conversationId || sessionId || '').trim();
    const pageLimit = Math.max(1, Math.min(200, Number(limit) || 80));
    const where = ["((conversation_id = ? AND conversation_id != '') OR (conversation_id = '' AND session_id = ?))", 'visible = 1'];
    const params = [conversationId, sessionId];
    const beforeCreatedAt = String(before?.createdAt || before?.created_at || '').trim();
    const beforeId = String(before?.id || '').trim();
    if (beforeCreatedAt && beforeId) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(beforeCreatedAt, beforeCreatedAt, beforeId);
    }
    params.push(pageLimit + 1);
    const rows = all(
      this.db,
      `SELECT * FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      params,
    );
    const hasMore = rows.length > pageLimit;
    const pageRows = rows.slice(0, pageLimit).reverse();
    const messageIds = pageRows.map((row) => String(row.id || '')).filter(Boolean);
    const attachmentsByMessageId = new Map();
    if (messageIds.length) {
      const placeholders = messageIds.map(() => '?').join(',');
      const attachmentRows = all(
        this.db,
        `SELECT * FROM message_attachments
         WHERE message_id IN (${placeholders})
           AND relation_type IN ('attachment','project_reference')
         ORDER BY message_id,created_at,id`,
        messageIds,
      ).map(normalizeMessageAttachment);
      for (const attachment of attachmentRows) {
        const items = attachmentsByMessageId.get(attachment.messageId) || [];
        items.push(attachment);
        attachmentsByMessageId.set(attachment.messageId, items);
      }
    }
    const items = pageRows.map(normalizeMessage).map((message) => (
      withStoredAttachmentRows(message, attachmentsByMessageId.get(message.id) || [])
    ));
    const oldest = items[0] || null;
    return {
      items,
      hasMore,
      nextCursor: hasMore && oldest ? { createdAt: oldest.createdAt || '', id: oldest.id || '' } : null,
    };
  },

  evidenceForAgent(agentId, limit = 40, { userId = '', agentInstanceId = '' } = {}) {
    const where = ["m.agent_id = ?", "(m.visible = 1 OR m.task_node_id != '')", "m.role IN ('user', 'assistant')"];
    const params = [agentId];
    if (userId) {
      where.push("EXISTS (SELECT 1 FROM sessions s WHERE s.id = m.session_id AND s.user_id = ?)");
      params.push(userId);
    }
    if (agentInstanceId) {
      where.push('m.agent_instance_id = ?');
      params.push(agentInstanceId);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT m.role, m.content, m.created_at, m.session_id, m.task_run_id, m.task_node_id,
              me.effective_model AS model_id, me.reasoning_effort, me.id AS model_execution_id
       FROM messages m
       LEFT JOIN model_executions me ON me.response_message_id = m.id
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC LIMIT ?`,
      params,
    )
      .reverse()
      .map((row) => ({ ...row }));
  }


  });
}

function recordMessageOutbox(store, message) {
  if (!message || !['user', 'assistant'].includes(message.role) || !String(message.content || '').trim()) return null;
  const session = message.sessionId ? get(store.db, 'SELECT * FROM sessions WHERE id=?', [message.sessionId]) : null;
  const taskNode = message.taskNodeId ? get(store.db, 'SELECT * FROM task_nodes WHERE id=?', [message.taskNodeId]) : null;
  const taskRunId = message.taskRunId || taskNode?.task_run_id || '';
  const taskRun = taskRunId ? get(store.db, 'SELECT * FROM task_runs WHERE id=?', [taskRunId]) : null;
  const agentInstanceId = message.agentInstanceId || session?.agent_instance_id || taskNode?.agent_instance_id || taskRun?.lead_agent_instance_id || '';
  const instance = agentInstanceId ? store.getUserAgentInstance?.(agentInstanceId) : null;
  const localUserId = instance?.userId || session?.user_id || taskRun?.owner_user_id || '';
  if (!instance || !localUserId || instance.userId !== localUserId) return null;
  const taskMetadata = safeJsonParse(taskRun?.metadata_json, {});
  const content = String(message.content || '');
  const outbox = store.recordEvolutionEvidenceOutbox({
    localUserId,
    userAgentInstanceId: instance.id,
    agentFamilyId: instance.agentFamilyId,
    sourceKind: 'message',
    sourceId: message.id,
    contentHash: sha256Text(content),
    contextSpaceId: message.contextSpaceId || '',
    taskRunId,
    delegationId: String(message.metadata?.delegationId || taskMetadata.delegationId || taskMetadata.delegation_id || ''),
    confidence: 1,
    privacyLevel: 'owner_private',
    createdAt: message.createdAt || nowIso(),
    snapshot: {
      content,
      role: message.role,
      sessionId: message.sessionId || '',
      taskRunId,
      taskNodeId: message.taskNodeId || '',
      contextSpaceId: message.contextSpaceId || '',
      visible: Boolean(message.visible),
      metadata: message.metadata || {},
      occurredAt: message.createdAt || nowIso(),
    },
  });
  if (message.role === 'assistant') recordConversationSegmentOutbox(store, { message, session, instance, taskRunId, taskMetadata });
  return outbox;
}

function withStoredAttachments(store, message) {
  if (!message) return message;
  const stored = all(store.db, `SELECT * FROM message_attachments
    WHERE message_id=? AND relation_type IN ('attachment','project_reference') ORDER BY created_at,id`, [message.id]).map(normalizeMessageAttachment);
  return withStoredAttachmentRows(message, stored);
}

function withStoredAttachmentRows(message, stored = []) {
  if (!message) return message;
  const attachments = stored.filter((item) => item.relationType === 'attachment');
  const fileReferences = stored.filter((item) => item.relationType === 'project_reference');
  const hasMetadataAttachments = Array.isArray(message.metadata?.attachments) && message.metadata.attachments.length;
  const hasMetadataReferences = Array.isArray(message.metadata?.fileReferences) && message.metadata.fileReferences.length;
  if ((!attachments.length || hasMetadataAttachments) && (!fileReferences.length || hasMetadataReferences)) return message;
  return {
    ...message,
    metadata: {
      ...(message.metadata || {}),
      ...(hasMetadataAttachments || !attachments.length ? {} : { attachments: attachments.map((item) => ({
        id: item.fileId || item.id,
        fileId: item.fileId || '',
        name: item.name,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        path: item.localPath,
        remoteFileId: item.remoteFileId,
        ...(item.metadata || {}),
      })) }),
      ...(hasMetadataReferences || !fileReferences.length ? {} : { fileReferences: fileReferences.map((item) => ({
        referenceId: item.metadata?.referenceId || item.fileId || item.id,
        referenceKind: item.metadata?.referenceKind || 'file',
        projectId: item.metadata?.projectId || '',
        relativePath: item.metadata?.relativePath || item.name,
        name: item.name,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        contentHash: item.metadata?.contentHash || item.sha256,
        modifiedAt: item.metadata?.modifiedAt || '',
        source: 'picker',
        memoryId: item.metadata?.memoryId || message.memoryId || '',
        contextSpaceId: item.metadata?.contextSpaceId || message.contextSpaceId || '',
      })) }),
    },
  };
}

function recordConversationSegmentOutbox(store, { message, session, instance, taskRunId = '', taskMetadata = {} } = {}) {
  if (!message?.sessionId || !session || !instance || !message.visible) return null;
  if (session.departmentId === 'private_assistant' || message.metadata?.localOnly) return null;
  const conversationId = message.conversationId || message.sessionId;
  const userRow = get(store.db, `SELECT * FROM messages WHERE conversation_id=? AND memory_id=? AND role='user' AND visible=1
    AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 1`, [
    conversationId,message.memoryId || '',message.createdAt || nowIso(),message.createdAt || nowIso(),message.id,
  ]);
  if (!userRow || !String(userRow.content || '').trim()) return null;
  const userMetadata = safeJsonParse(userRow.metadata_json, {});
  if (userMetadata.localOnly) return null;
  const earlierAssistant = get(store.db, `SELECT id FROM messages WHERE conversation_id=? AND memory_id=? AND role='assistant' AND visible=1
    AND ((created_at>? OR (created_at=? AND id>?)) AND (created_at<? OR (created_at=? AND id<?))) LIMIT 1`, [
    conversationId,message.memoryId || '',userRow.created_at,userRow.created_at,userRow.id,message.createdAt || nowIso(),message.createdAt || nowIso(),message.id,
  ]);
  if (earlierAssistant) return null;
  const sourceVersionId = `segment_${sha256Text(`${userRow.id}\n${message.id}`).slice(0,32)}`;
  const lineageKey = `conversation:${conversationId}:${message.memoryId || ''}:${userRow.id}:${message.id}`;
  const content = `User:\n${String(userRow.content).trim()}\n\nAssistant:\n${String(message.content).trim()}`;
  const executionOutbox = store.recordEvolutionEvidenceOutbox({
    localUserId: instance.userId,userAgentInstanceId:instance.id,agentFamilyId:instance.agentFamilyId,
    sourceKind:'conversation_segment',sourceId:conversationId,sourceVersionId,lineageKey,contentHash:sha256Text(content),
    contextSpaceId:message.contextSpaceId || userRow.context_space_id || '',taskRunId,
    delegationId:String(message.metadata?.delegationId || taskMetadata.delegationId || taskMetadata.delegation_id || ''),
    confidence:1,privacyLevel:'owner_private',createdAt:message.createdAt || nowIso(),
    snapshot:{content,conversationId,memoryId:message.memoryId || '',sessionId:message.sessionId,sourceMessageIds:[userRow.id,message.id],userMessageId:userRow.id,
      assistantMessageId:message.id,taskRunId,occurredAt:message.createdAt || nowIso()},
  });
}

function recordModelExecutionOutbox(store, execution) {
  if (!execution || !terminalModelExecutionStatus(execution.status)) return null;
  const session = execution.conversationId ? get(store.db, 'SELECT * FROM sessions WHERE id=?', [execution.conversationId]) : null;
  const taskNode = execution.taskNodeId ? get(store.db, 'SELECT * FROM task_nodes WHERE id=?', [execution.taskNodeId]) : null;
  const taskRunId = execution.taskRunId || taskNode?.task_run_id || '';
  const taskRun = taskRunId ? get(store.db, 'SELECT * FROM task_runs WHERE id=?', [taskRunId]) : null;
  const agentInstanceId = execution.agentInstanceId || session?.agent_instance_id || taskNode?.agent_instance_id || taskRun?.lead_agent_instance_id || '';
  const instance = agentInstanceId ? store.getUserAgentInstance?.(agentInstanceId) : null;
  const localUserId = instance?.userId || execution.userId || session?.user_id || taskRun?.owner_user_id || '';
  if (!instance || !localUserId || instance.userId !== localUserId) return null;
  const taskMetadata = safeJsonParse(taskRun?.metadata_json, {});
  const snapshot = {
    status: execution.status,
    executionKind: execution.executionKind || '',
    providerId: execution.providerId || '',
    requestedModel: execution.requestedModel || '',
    effectiveModel: execution.effectiveModel || '',
    reasoningEffort: execution.reasoningEffort || '',
    modelSource: execution.modelSource || '',
    projectId: execution.projectId || '',
    conversationId: execution.conversationId || '',
    requestMessageId: execution.requestMessageId || '',
    responseMessageId: execution.responseMessageId || '',
    taskRunId,
    taskNodeId: execution.taskNodeId || '',
    departmentId: execution.departmentId || '',
    agentVersionId: execution.agentVersionId || '',
    personalSkillVersionId: execution.personalSkillVersionId || '',
    skillHash: execution.skillHash || '',
    memoryHash: execution.memoryHash || '',
    memoryManifestHash: execution.memoryManifestHash || '',
    organizationVersion: execution.organizationVersion || '',
    errorText: execution.errorText || '',
    metadata: execution.metadata || {},
    startedAt: execution.startedAt || '',
    completedAt: execution.completedAt || execution.updatedAt || '',
    occurredAt: execution.completedAt || execution.updatedAt || nowIso(),
  };
  const content = JSON.stringify(snapshot);
  const executionOutbox = store.recordEvolutionEvidenceOutbox({
    localUserId,
    userAgentInstanceId: instance.id,
    agentFamilyId: instance.agentFamilyId,
    sourceKind: 'model_execution',
    sourceId: execution.id,
    sourceVersionId: execution.completedAt || execution.updatedAt || '',
    contentHash: sha256Text(content),
    contextSpaceId: session?.agent_instance_id === instance.id ? String(execution.metadata?.contextSpaceId || '') : '',
    taskRunId,
    delegationId: String(execution.metadata?.delegationId || taskMetadata.delegationId || taskMetadata.delegation_id || ''),
    confidence: 1,
    privacyLevel: 'owner_private',
    createdAt: execution.completedAt || execution.updatedAt || nowIso(),
    snapshot: { ...snapshot, content },
  });
  const startedAt = Date.parse(snapshot.startedAt || '');
  const completedAt = Date.parse(snapshot.completedAt || '');
  const metricSnapshot = {
    status: snapshot.status,
    executionKind: snapshot.executionKind,
    providerId: snapshot.providerId,
    effectiveModel: snapshot.effectiveModel,
    reasoningEffort: snapshot.reasoningEffort,
    durationMs: Number.isFinite(startedAt) && Number.isFinite(completedAt) ? Math.max(0, completedAt - startedAt) : 0,
    usage: execution.metadata?.usage || execution.metadata?.tokenUsage || execution.metadata?.token_usage || {},
    taskRunId,
    taskNodeId: snapshot.taskNodeId,
    occurredAt: snapshot.occurredAt,
  };
  const metricContent = JSON.stringify(metricSnapshot);
  store.recordEvolutionEvidenceOutbox({
    localUserId,
    userAgentInstanceId: instance.id,
    agentFamilyId: instance.agentFamilyId,
    sourceKind: 'model_execution_metric',
    sourceId: execution.id,
    sourceVersionId: execution.completedAt || execution.updatedAt || '',
    contentHash: sha256Text(metricContent),
    taskRunId,
    delegationId: String(execution.metadata?.delegationId || taskMetadata.delegationId || taskMetadata.delegation_id || ''),
    confidence: 1,
    privacyLevel: 'owner_private',
    createdAt: snapshot.occurredAt,
    snapshot: { ...metricSnapshot, content: metricContent },
  });
  return executionOutbox;
}

function terminalModelExecutionStatus(status = '') {
  return ['completed', 'failed', 'cancelled'].includes(String(status || '').trim());
}
