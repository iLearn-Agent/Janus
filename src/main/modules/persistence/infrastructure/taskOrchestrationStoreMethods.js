import { all, get, run } from '../../../db.js';
import { classifyPrivacy, memoryMergeDecision, privateMemoryMarker } from '../../../memory.js';
import { newId, nowIso, safeJsonParse, sha256Text } from '../../../utils.js';
import { normalizeProject, normalizeSession, normalizeInteractionMode, normalizeWorkspacePath, requestCodexThreadReset, normalizeGoalStatus, compareSessionsForDisplay, normalizeMemoryEntryContent, normalizeSearchText, textMatchesQuery, compactPreviewText, messageMetadataSearchText, flattenSearchValues, searchMatchExcerpt, normalizeMessage, normalizeModelExecution, normalizeTaskRun, normalizeTaskNode, normalizeTaskEvent, normalizeTaskGraphRevision, normalizeTaskNodeResultVersion, normalizeCommunication, normalizeTaskRetrospective, normalizeMemoryEntry, normalizeMemoryAudit, normalizeEvolutionRun, normalizeArchive, normalizeSkillVersion, normalizeTypedMemory, normalizeHrReview, normalizeAgentEvolutionReview, normalizeGovernanceEvent, normalizePerformanceReview, normalizeSpecialistExperiment, normalizeWorkflowCredit } from '../domain/recordNormalizers.js';

const TERMINAL_AGENT_STATUS_TASKS = new Set(['completed', 'failed', 'cancelled']);

export function installTaskOrchestrationStoreMethods(prototype) {
  Object.assign(prototype, {
  createTaskRun({ id: providedId = '', title, prompt, departmentId = '', leadAgentId = '', ownerUserId = '', leadAgentInstanceId = '', metadata = {}, workspaceId = '', deferAgentInstanceBinding = false, initialStatus = 'pending' }) {
    const id = String(providedId || '').trim() || newId('task');
    const resolvedOwnerUserId = ownerUserId || metadata.userId || '';
    const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({
      userId: resolvedOwnerUserId, workspaceId: workspaceId || metadata.accountWorkspaceId || metadata.workspaceId,
    }) || 'workspace_personal';
    const resolvedLeadInstance = leadAgentInstanceId
      ? resolvedOwnerUserId
        ? this.requireRoutableUserAgent?.({
            userId: resolvedOwnerUserId,
            agentInstanceId: leadAgentInstanceId,
            agentFamilyId: leadAgentId,
          })?.instance || null
        : this.getUserAgentInstance?.(leadAgentInstanceId)
      : !deferAgentInstanceBinding && resolvedOwnerUserId && leadAgentId
        ? this.requireRoutableUserAgent?.({ userId: resolvedOwnerUserId, agentFamilyId: leadAgentId })?.instance || null
        : null;
    const ownsTransaction=!this.db.isTransaction;if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE');
    try {
    const existingTask = providedId ? get(this.db, 'SELECT id FROM task_runs WHERE id=?', [id]) : null;
    if (existingTask) {
      run(this.db, `UPDATE task_runs SET account_workspace_id=?,owner_user_id=?,title=?,prompt=?,department_id=?,lead_agent_id=?,
        lead_agent_instance_id=?,status=?,summary='',metadata_json=?,completed_at=NULL,updated_at=? WHERE id=?`, [
        resolvedWorkspaceId, resolvedOwnerUserId, title || prompt.slice(0, 60) || 'Complex task', prompt, departmentId, leadAgentId,
        resolvedLeadInstance?.id || '', String(initialStatus || 'pending'), JSON.stringify({ ...metadata, accountWorkspaceId: resolvedWorkspaceId }),
        nowIso(), id,
      ]);
    } else run(
      this.db,
      `INSERT INTO task_runs (
        id, account_workspace_id, owner_user_id, title, prompt, department_id, lead_agent_id,
        lead_agent_instance_id, status, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, resolvedWorkspaceId, resolvedOwnerUserId, title || prompt.slice(0, 60) || 'Complex task', prompt, departmentId, leadAgentId,
        resolvedLeadInstance?.id || '', String(initialStatus || 'pending'), JSON.stringify({ ...metadata, accountWorkspaceId: resolvedWorkspaceId })],
    );
    this.ensureTaskWorkScope?.({
      taskRunId: id,
      parentWorkScopeId: metadata.parentWorkScopeId || '',
      revisionId: metadata.workRevisionId || '',
      federationType: metadata.workFederationType || '',
      federationId: metadata.workFederationId || '',
    });
    this.ensureTaskSecurityContext?.({
      taskRunId: id,
      ownerUserId: resolvedOwnerUserId,
      cloudEvolutionAllowed: Boolean(metadata.cloudEvolutionAllowed),
      cloudCollaborationAllowed: Boolean(metadata.cloudCollaborationAllowed),
    });
    if (resolvedLeadInstance?.id) {
      this.ensureTaskMemoryDocument?.({
        agentInstanceId: resolvedLeadInstance.id,
        taskRunId: id,
        taskTitle: title || prompt.slice(0, 60) || 'Complex task',
        cloudEvolutionAllowed: Boolean(metadata.cloudEvolutionAllowed),
        workspaceId: resolvedWorkspaceId,
      });
    }
    this.recordTaskEvent({
      taskRunId: id,
      eventType: existingTask ? 'task_planning_completed' : 'task_created',
      actorId: leadAgentId,
      summary: existingTask ? 'Persistent uBuddy planning completed and the task graph was materialized.' : title || prompt.slice(0, 80) || 'Complex task created.',
      payload: { departmentId, leadAgentId },
    });
    this.upsertMemoryEntry({
      scope: 'short_term',
      ownerId: id,
      userId: resolvedOwnerUserId,
      departmentId,
      agentId: leadAgentId,
      agentInstanceId: resolvedLeadInstance?.id || '',
      taskRunId: id,
      memoryType: 'temporary_context',
      content: prompt,
      lifecycleState: 'active',
      confidence: 0.5,
      sourceKind: 'task_created',
      sourceId: id,
      reviewStatus: 'task_local',
    });
    if(ownsTransaction)this.db.exec('COMMIT');return this.getTaskRun(id);
    } catch(error){if(ownsTransaction)this.db.exec('ROLLBACK');throw error;}
  },

  getTaskRun(id) {
    const row = normalizeTaskRun(get(this.db, 'SELECT * FROM task_runs WHERE id = ?', [id]));
    if (!row) return null;
    row.nodes = this.listTaskNodes(id);
    row.communications = this.listCommunications(id);
    row.events = this.listTaskEvents(id);
    row.revisions = this.listTaskGraphRevisions(id);
    row.resultVersions = this.listTaskNodeResultVersions({ taskRunId: id });
    row.retrospective = this.getTaskRetrospective(id);
    row.deliveryReview = this.getTaskDeliveryReview?.(id) || null;
    row.deliverySubmissions = this.listTaskDeliverySubmissions?.(id) || [];
    row.deliveryReviewEvents = this.listTaskDeliveryReviewEvents?.(id) || [];
    return row;
  },

  getTaskRunUpdateSnapshot(id, { eventLimit = 50 } = {}) {
    const row = normalizeTaskRun(get(this.db, 'SELECT * FROM task_runs WHERE id = ?', [id]));
    if (!row) return null;
    const safeEventLimit = Math.max(1, Math.min(200, Number(eventLimit || 50)));
    row.nodes = this.listTaskNodes(id);
    row.communications = this.listCommunications(id);
    row.events = all(this.db, `SELECT * FROM (
      SELECT * FROM task_events WHERE task_run_id=? ORDER BY created_at DESC,id DESC LIMIT ?
    ) ORDER BY created_at ASC,id ASC`, [id, safeEventLimit]).map(normalizeTaskEvent);
    row.eventCount = Number(get(this.db, 'SELECT COUNT(*) AS count FROM task_events WHERE task_run_id=?', [id])?.count || 0);
    row.eventHistoryPartial = row.eventCount > row.events.length;
    row.revisions = this.listTaskGraphRevisions(id);
    row.resultVersions = this.listTaskNodeResultVersions({ taskRunId: id });
    row.retrospective = this.getTaskRetrospective(id);
    row.deliveryReview = this.getTaskDeliveryReview?.(id) || null;
    row.deliverySubmissions = this.listTaskDeliverySubmissions?.(id) || [];
    row.deliveryReviewEvents = this.listTaskDeliveryReviewEvents?.(id) || [];
    return row;
  },

  listTaskRuns({ limit = 80, userId = '', workspaceId = '', allWorkspaces = false } = {}) {
    const where = [];
    const params = [];
    if (userId) { where.push('tr.owner_user_id = ?'); params.push(userId); }
    if (userId && !allWorkspaces) {
      where.push('tr.account_workspace_id = ?');
      params.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal');
    }
    params.push(Math.max(1, Math.min(500, Number(limit || 80))));
    return all(
      this.db,
      `SELECT tr.*,
              (SELECT COUNT(*) FROM task_nodes tn WHERE tn.task_run_id = tr.id) AS node_count,
              (SELECT COUNT(*) FROM task_nodes tn WHERE tn.task_run_id = tr.id AND tn.status = 'completed') AS completed_node_count,
              (SELECT COUNT(*) FROM task_nodes tn WHERE tn.task_run_id = tr.id AND tn.status IN ('waiting', 'retry_wait', 'blocked')) AS waiting_node_count,
              (SELECT COUNT(*) FROM task_nodes tn WHERE tn.task_run_id = tr.id AND tn.status = 'retry_wait') AS retrying_node_count,
              (SELECT COUNT(*) FROM communications c WHERE c.task_run_id = tr.id AND c.status = 'open') AS open_communication_count
       FROM task_runs tr
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY tr.updated_at DESC LIMIT ?`,
      params,
    ).map(normalizeTaskRun);
  },

  listTaskRunProjectionFacts({ taskRunIds = [] } = {}) {
    const ids = [...new Set((Array.isArray(taskRunIds) ? taskRunIds : []).map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 500);
    if (!ids.length) return {};
    const placeholders = ids.map(() => '?').join(',');
    const result = Object.fromEntries(ids.map((id) => [id, { nodes: [], events: [] }]));
    for (const node of all(this.db, `SELECT * FROM task_nodes WHERE task_run_id IN (${placeholders})
      ORDER BY task_run_id,priority,created_at`, ids).map(normalizeTaskNode)) {
      if (result[node.taskRunId]) result[node.taskRunId].nodes.push(node);
    }
    for (const event of all(this.db, `SELECT * FROM (
        SELECT task_events.*,ROW_NUMBER() OVER (
          PARTITION BY task_run_id ORDER BY updated_at DESC,created_at DESC,id DESC
        ) AS projection_row_no
        FROM task_events WHERE task_run_id IN (${placeholders})
      ) WHERE projection_row_no<=200 ORDER BY task_run_id,created_at`, ids).map(normalizeTaskEvent)) {
      if (result[event.taskRunId]) result[event.taskRunId].events.push(event);
    }
    return result;
  },

  findTaskRunForDelegation({ delegationId = '', userId = '', statuses = [], workspaceId = '', allWorkspaces = false } = {}) {
    const cleanDelegationId = String(delegationId || '').trim();
    if (!cleanDelegationId) return null;
    const where = ["COALESCE(json_extract(metadata_json, '$.delegationId'), json_extract(metadata_json, '$.delegation_id')) = ?"];
    const params = [cleanDelegationId];
    if (userId) {
      where.push('owner_user_id = ?');
      params.push(String(userId));
      if (!allWorkspaces) {
        where.push('account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal');
      }
    }
    const normalizedStatuses = [...new Set((Array.isArray(statuses) ? statuses : [])
      .map((status) => String(status || '').trim()).filter(Boolean))];
    if (normalizedStatuses.length) {
      where.push(`status IN (${normalizedStatuses.map(() => '?').join(', ')})`);
      params.push(...normalizedStatuses);
    }
    const row = get(
      this.db,
      `SELECT id FROM task_runs WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      params,
    );
    return row?.id ? this.getTaskRun(row.id) : null;
  },

  updateTaskRunStatus(id, status, summary = '') {
    run(
      this.db,
      `UPDATE task_runs
       SET status = ?, summary = COALESCE(NULLIF(?, ''), summary), updated_at = ?,
           completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE NULL END
       WHERE id = ?`,
      [status, summary, nowIso(), status, nowIso(), id],
    );
    this.ensureTaskWorkScope?.({ taskRunId: id });
  },

  updateTaskRunMetadata(id, metadata = {}, { replace = false } = {}) {
    const task = this.getTaskRun(id);
    if (!task) return null;
    const nextMetadata = replace
      ? (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {})
      : {
          ...(task.metadata || {}),
          ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        };
    run(
      this.db,
      'UPDATE task_runs SET metadata_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(nextMetadata), nowIso(), id],
    );
    return this.getTaskRun(id);
  },

  deleteTaskRun(id) {
    const task = this.getTaskRun(id);
    if (!task) return null;
    run(this.db, "UPDATE work_scopes SET status='closed',updated_at=? WHERE scope_type='task_run' AND source_id=?", [nowIso(), id]);
    run(this.db, 'DELETE FROM communications WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM task_events WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM task_graph_revisions WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM task_node_result_versions WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM task_retrospectives WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM memory_entries WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM messages WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM task_nodes WHERE task_run_id = ?', [id]);
    run(this.db, 'DELETE FROM task_runs WHERE id = ?', [id]);
    run(this.db, "UPDATE task_security_contexts SET status='archived',updated_at=? WHERE task_run_id=?", [nowIso(), id]);
    run(this.db, "UPDATE memory_documents SET lifecycle_state='archived',updated_at=? WHERE scope='task' AND task_run_id=?", [nowIso(), id]);
    return task;
  },

  createTaskNode({
    taskRunId,
    title,
    objective,
    departmentId = '',
    agentId = '',
    agentInstanceId = '',
    status = 'pending',
    dependencies = [],
    outputFormat = '',
    estimatedMinutes = 0,
    priority = 50,
    parallelGroup = '',
    blocking = false,
    notify = [],
    fallback = '',
    maxAttempts = 3,
    retryStrategy = 'automatic',
    deferAgentInstanceBinding = false,
  }) {
    const id = newId('node');
    const task = this.getTaskRun(taskRunId);
    const resolvedInstance = agentInstanceId
      ? task?.ownerUserId
        ? this.requireRoutableUserAgent?.({
            userId: task.ownerUserId,
            agentInstanceId,
            agentFamilyId: agentId,
          })?.instance || null
        : this.getUserAgentInstance?.(agentInstanceId)
      : !deferAgentInstanceBinding && task?.ownerUserId && agentId
        ? this.requireRoutableUserAgent?.({ userId: task.ownerUserId, agentFamilyId: agentId })?.instance || null
        : null;
    const ownsTransaction=!this.db.isTransaction;if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE');
    try {
    run(
      this.db,
      `INSERT INTO task_nodes (
        id, task_run_id, title, objective, department_id, agent_id, agent_instance_id, status,
        dependencies_json, output_format, estimated_minutes, priority, parallel_group, blocking,
        notify_json, fallback, max_attempts, retry_strategy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        taskRunId,
        title,
        objective,
        departmentId,
        agentId,
        resolvedInstance?.id || '',
        status,
        JSON.stringify(dependencies),
        outputFormat,
        Math.max(0, Math.round(Number(estimatedMinutes || 0))),
        priority,
        parallelGroup,
        blocking ? 1 : 0,
        JSON.stringify(notify),
        fallback,
        Math.max(1, Math.min(10, Math.round(Number(maxAttempts || 3)))),
        String(retryStrategy || 'automatic'),
      ],
    );
    if (resolvedInstance?.id) {
      this.ensureTaskWorkScope?.({ taskRunId });
      this.ensureTaskMemoryDocument?.({
        agentInstanceId: resolvedInstance.id,
        taskRunId,
        taskTitle: task?.title || title || 'Task',
        cloudEvolutionAllowed: Boolean(task?.metadata?.cloudEvolutionAllowed),
      });
      this.recordTaskEvent({taskRunId,taskNodeId:id,eventType:'task_assigned',actorId:agentId,
        summary:`${title || 'Task node'} assigned.`,payload:{agentInstanceId:resolvedInstance.id,agentId,dependencies}});
    }
    if(ownsTransaction)this.db.exec('COMMIT');return this.getTaskNode(id);
    } catch(error){if(ownsTransaction)this.db.exec('ROLLBACK');throw error;}
  },

  recordTaskEvent({
    eventId = '',
    taskRunId,
    taskNodeId = '',
    eventType,
    actorId = '',
    privacyLevel = '',
    status = '',
    summary = '',
    command = '',
    output = '',
    payload = {},
  }) {
    const id = String(eventId || '').trim() || newId('event');
    const previous = eventId ? this.getTaskEvent(id) : null;
    if (previous && (previous.taskRunId !== taskRunId || previous.taskNodeId !== taskNodeId)) {
      throw new Error(`Task event identity conflict: ${id}`);
    }
    const payloadObject = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const processEvent = Boolean(eventId || status || command || output || payloadObject.activityId || payloadObject.activityType);
    const inferredLocalPrivate = taskProcessEventIsLocalPrivate({ command, output, payload: payloadObject });
    const resolvedPrivacyLevel = String(privacyLevel || (
      previous?.privacyLevel === 'local_private' || inferredLocalPrivate
        ? 'local_private'
        : previous?.privacyLevel || 'owner_private'
    ));
    const nextPayload = processEvent
      ? mergeTaskProcessEventPayload(previous?.payload, {
          ...payloadObject,
          ...(status ? { status } : {}),
          ...(command ? { command } : {}),
          ...(output ? { output } : {}),
        })
      : payloadObject;
    const activityType = String(nextPayload.activityType || '');
    const nextSummary = processEvent && ['reasoning', 'commentary'].includes(activityType)
      ? clipTaskEventText(String(nextPayload.detail || summary || previous?.summary || ''), 600)
      : summary || previous?.summary || '';
    const updatedAt = nowIso();
    run(
      this.db,
      `INSERT INTO task_events (id, task_run_id, task_node_id, event_type, actor_id, privacy_level, summary, payload_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         event_type = excluded.event_type,
         actor_id = excluded.actor_id,
         privacy_level = excluded.privacy_level,
         summary = excluded.summary,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at
       WHERE task_events.task_run_id = excluded.task_run_id
         AND task_events.task_node_id = excluded.task_node_id`,
      [
        id,
        taskRunId,
        taskNodeId,
        eventType,
        actorId,
        resolvedPrivacyLevel,
        nextSummary,
        JSON.stringify(nextPayload),
        updatedAt,
      ],
    );
    const event=this.getTaskEvent(id);
    recordTaskLifecycleEventOutbox(this,{event});
    return event;
  },

  getTaskEvent(id) {
    return normalizeTaskEvent(get(this.db, 'SELECT * FROM task_events WHERE id = ?', [id]));
  },

  listTaskEvents(taskRunId) {
    return all(
      this.db,
      `SELECT * FROM task_events WHERE task_run_id = ? ORDER BY created_at ASC`,
      [taskRunId],
    ).map(normalizeTaskEvent);
  },

  settleTaskProcessEvents({ taskRunId = '', taskNodeId = '', status = 'completed' } = {}) {
    const terminalStatus = ['completed', 'failed', 'cancelled'].includes(String(status || '')) ? String(status) : 'completed';
    const events = this.listTaskEvents(taskRunId).filter((event) => (
      (!taskNodeId || event.taskNodeId === taskNodeId)
      && event.payload?.activityId
      && ['running', 'waiting', 'blocked', ''].includes(String(event.status || ''))
    ));
    const completedAtMs = Date.now();
    return events.map((event) => this.recordTaskEvent({
      eventId: event.id,
      taskRunId: event.taskRunId,
      taskNodeId: event.taskNodeId,
      eventType: event.eventType,
      actorId: event.actorId,
      privacyLevel: event.privacyLevel,
      status: terminalStatus,
      summary: event.summary,
      payload: {
        ...(event.payload || {}),
        status: terminalStatus,
        completedAtMs: event.payload?.completedAtMs || completedAtMs,
        append: false,
        appendOutput: false,
      },
    }));
  },

  recordTaskGraphRevision({
    taskRunId,
    revisionType,
    reason = '',
    before = {},
    after = {},
    actorId = '',
  }) {
    const id = newId('revision');
    const ownsTransaction=!this.db.isTransaction;if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE');
    try { run(
      this.db,
      `INSERT INTO task_graph_revisions (
        id, task_run_id, revision_type, reason, before_json, after_json, actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, taskRunId, revisionType, reason, JSON.stringify(before), JSON.stringify(after), actorId],
    );
    this.recordTaskEvent({
      taskRunId,
      eventType: `graph_${revisionType}`,
      actorId,
      summary: reason,
      payload: { revisionId:id, before, after },
    });
    if(ownsTransaction)this.db.exec('COMMIT');return this.getTaskGraphRevision(id);
    } catch(error){if(ownsTransaction)this.db.exec('ROLLBACK');throw error;}
  },

  getTaskGraphRevision(id) {
    return normalizeTaskGraphRevision(get(this.db, 'SELECT * FROM task_graph_revisions WHERE id = ?', [id]));
  },

  listTaskGraphRevisions(taskRunId) {
    return all(
      this.db,
      `SELECT * FROM task_graph_revisions WHERE task_run_id = ? ORDER BY created_at ASC`,
      [taskRunId],
    ).map(normalizeTaskGraphRevision);
  },

  recordTaskNodeResultVersion({ taskRunId = '', taskNodeId = '', graphRevisionId = '', resultText = '', resultSummary = '', evidenceRefs = [], decision = 'pending', decisionReason = '' } = {}) {
    if (!taskRunId || !taskNodeId) throw new Error('Task node result version requires task and node identity.');
    const versionNo = Number(get(this.db, 'SELECT COALESCE(MAX(version_no), 0) AS version_no FROM task_node_result_versions WHERE task_node_id = ?', [taskNodeId])?.version_no || 0) + 1;
    const id = newId('node_result');
    const decidedAt = decision === 'pending' ? null : nowIso();
    run(this.db, `INSERT INTO task_node_result_versions (
      id,task_run_id,task_node_id,graph_revision_id,version_no,result_text,result_summary,evidence_json,decision,decision_reason,decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, taskRunId, taskNodeId, graphRevisionId, versionNo, String(resultText || ''), String(resultSummary || ''),
      JSON.stringify(Array.isArray(evidenceRefs) ? evidenceRefs : []), decision, String(decisionReason || ''), decidedAt,
    ]);
    return this.getTaskNodeResultVersion(id);
  },

  getTaskNodeResultVersion(id) {
    return normalizeTaskNodeResultVersion(get(this.db, 'SELECT * FROM task_node_result_versions WHERE id = ?', [id]));
  },

  listTaskNodeResultVersions({ taskRunId = '', taskNodeId = '', decision = '' } = {}) {
    const where = ['1 = 1'];
    const params = [];
    if (taskRunId) { where.push('task_run_id = ?'); params.push(taskRunId); }
    if (taskNodeId) { where.push('task_node_id = ?'); params.push(taskNodeId); }
    if (decision) { where.push('decision = ?'); params.push(decision); }
    return all(this.db, `SELECT * FROM task_node_result_versions WHERE ${where.join(' AND ')} ORDER BY created_at,version_no`, params).map(normalizeTaskNodeResultVersion);
  },

  decideTaskNodeResultVersion({ id = '', decision = 'adopted', reason = '' } = {}) {
    if (!['adopted', 'superseded', 'rejected'].includes(decision)) throw new Error('Invalid task node result decision.');
    run(this.db, 'UPDATE task_node_result_versions SET decision = ?, decision_reason = ?, decided_at = ? WHERE id = ?', [decision, String(reason || ''), nowIso(), id]);
    return this.getTaskNodeResultVersion(id);
  },

  getTaskNode(id) {
    return normalizeTaskNode(get(this.db, 'SELECT * FROM task_nodes WHERE id = ?', [id]));
  },

  listTaskNodes(taskRunId) {
    return all(
      this.db,
      `SELECT * FROM task_nodes
       WHERE task_run_id = ?
       ORDER BY priority ASC, created_at ASC`,
      [taskRunId],
    ).map(normalizeTaskNode);
  },

  updateTaskNode(id, fields) {
    const allowed = {
      title: { column: 'title', value: (value) => String(value || '') },
      objective: { column: 'objective', value: (value) => String(value || '') },
      departmentId: { column: 'department_id', value: (value) => String(value || '') },
      agentId: { column: 'agent_id', value: (value) => String(value || '') },
      agentInstanceId: { column: 'agent_instance_id', value: (value) => String(value || '') },
      status: { column: 'status', value: (value) => String(value || '') },
      dependencies: { column: 'dependencies_json', value: (value) => JSON.stringify(Array.isArray(value) ? value : []) },
      outputFormat: { column: 'output_format', value: (value) => String(value || '') },
      estimatedMinutes: { column: 'estimated_minutes', value: (value) => Math.max(0, Math.round(Number(value || 0))) },
      priority: { column: 'priority', value: (value) => Math.round(Number(value || 0)) },
      parallelGroup: { column: 'parallel_group', value: (value) => String(value || '') },
      blocking: { column: 'blocking', value: (value) => (value ? 1 : 0) },
      notify: { column: 'notify_json', value: (value) => JSON.stringify(Array.isArray(value) ? value : []) },
      fallback: { column: 'fallback', value: (value) => String(value || '') },
      resultText: { column: 'result_text', value: (value) => String(value || '') },
      resultSummary: { column: 'result_summary', value: (value) => String(value || '') },
      evidenceRefs: { column: 'evidence_json', value: (value) => JSON.stringify(Array.isArray(value) ? value : []) },
      errorText: { column: 'error_text', value: (value) => String(value || '') },
      waitReason: { column: 'wait_reason', value: (value) => String(value || '') },
      timeoutPolicy: { column: 'timeout_policy', value: (value) => String(value || '') },
      attemptCount: { column: 'attempt_count', value: (value) => Math.max(0, Math.round(Number(value || 0))) },
      maxAttempts: { column: 'max_attempts', value: (value) => Math.max(1, Math.min(10, Math.round(Number(value || 3)))) },
      nextRetryAt: { column: 'next_retry_at', value: (value) => String(value || '') },
      lastErrorCode: { column: 'last_error_code', value: (value) => String(value || '') },
      retryStrategy: { column: 'retry_strategy', value: (value) => String(value || 'automatic') },
      recoveryActions: { column: 'recovery_actions_json', value: (value) => JSON.stringify(Array.isArray(value) ? value : []) },
      startedAt: { column: 'started_at', value: (value) => value || null },
      completedAt: { column: 'completed_at', value: (value) => value || null },
    };
    const entries = Object.entries(fields).filter(([key]) => allowed[key]);
    if (!entries.length) return this.getTaskNode(id);
    const before = this.getTaskNode(id);
    const sets = entries.map(([key]) => `${allowed[key].column} = ?`);
    const values = entries.map(([key, value]) => allowed[key].value(value));
    sets.push('updated_at = ?');
    values.push(nowIso(), id);
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      run(this.db, `UPDATE task_nodes SET ${sets.join(', ')} WHERE id = ?`, values);
      const after = this.getTaskNode(id);
      if (before && after && before.status !== after.status) {
        const event = this.recordTaskEvent({
          taskRunId: after.taskRunId,
          taskNodeId: after.id,
          eventType: `node_${after.status}`,
          actorId: after.agentId,
          summary: `${after.title}: ${before.status} -> ${after.status}`,
          payload: {
            before: before.status,
            after: after.status,
            resultText: after.resultText || '',
            resultSummary: after.resultSummary || '',
            evidenceRefs: after.evidenceRefs || [],
            errorText: after.errorText || '',
            waitReason: after.waitReason || '',
            completedAt: after.completedAt || '',
          },
        });
        if (terminalTaskEvidenceSourceKind(after.status)) recordTaskEventOutbox(this, { taskNode: after, event });
      }
      if(before&&after&&Object.hasOwn(fields,'dependencies')&&JSON.stringify(before.dependencies||[])!==JSON.stringify(after.dependencies||[])){
        this.recordTaskEvent({taskRunId:after.taskRunId,taskNodeId:after.id,eventType:'task_dependency_changed',actorId:after.agentId,
          summary:`${after.title}: dependencies changed`,payload:{before:before.dependencies||[],after:after.dependencies||[]}});
      }
      if (ownsTransaction) this.db.exec('COMMIT');
      return after;
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  readyTaskNodes(taskRunId) {
    const nodes = this.listTaskNodes(taskRunId);
    const completed = new Set(nodes.filter((node) => node.status === 'completed').map((node) => node.id));
    return nodes.filter((node) => {
      if (!['pending', 'ready'].includes(node.status)) return false;
      return (node.dependencies || []).every((dep) => completed.has(dep));
    });
  },

  tryClaimTaskNode(id) {
    const result = run(
      this.db,
      `UPDATE task_nodes SET status = 'queued', updated_at = ?
       WHERE id = ? AND status IN ('pending', 'ready')`,
      [nowIso(), id],
    );
    return Number(result?.changes || 0) > 0 ? this.getTaskNode(id) : null;
  },

  clearTaskRetrospective(taskRunId) {
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      run(this.db, 'DELETE FROM task_retrospectives WHERE task_run_id = ?', [taskRunId]);
      run(this.db, `DELETE FROM memory_entries
        WHERE task_run_id = ? AND source_kind = 'task_retrospective' AND source_id = ?`, [taskRunId, taskRunId]);
      if (ownsTransaction) this.db.exec('COMMIT');
      return true;
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  },

  createCommunication({
    taskRunId,
    fromAgentId,
    toAgentId,
    purpose,
    requestedInfo,
    priority = 'normal',
    blocking = false,
    expectedFormat = '',
    contextSummary = '',
    references = [],
    status = 'open',
    responseText = '',
  }) {
    const id = newId('comm');
    const resolvedAt = status === 'open' ? null : nowIso();
    run(
      this.db,
      `INSERT INTO communications (
        id, task_run_id, from_agent_id, to_agent_id, purpose, requested_info,
        priority, blocking, expected_format, context_summary, references_json,
        response_text, status, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        taskRunId,
        fromAgentId,
        toAgentId,
        purpose,
        requestedInfo,
        priority,
        blocking ? 1 : 0,
        expectedFormat,
        contextSummary,
        JSON.stringify(references),
        responseText,
        status,
        resolvedAt,
      ],
    );
    this.recordTaskEvent({
      taskRunId,
      eventType: 'communication_opened',
      actorId: fromAgentId,
      summary: `${fromAgentId} -> ${toAgentId}: ${purpose || requestedInfo}`,
      payload: { toAgentId, blocking, priority, expectedFormat },
    });
    return this.getCommunication(id);
  },

  resolveCommunication(id, { responseText = '', status = 'resolved', responderId = '' } = {}) {
    const before = this.getCommunication(id);
    run(
      this.db,
      `UPDATE communications
       SET response_text = ?, status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      [responseText, status, id],
    );
    const after = this.getCommunication(id);
    if (after) {
      this.recordTaskEvent({
        taskRunId: after.taskRunId,
        eventType: 'communication_resolved',
        actorId: responderId || after.toAgentId,
        summary: `${after.toAgentId} responded to ${after.fromAgentId}`,
        payload: { beforeStatus: before?.status, status, responseText },
      });
    }
    return after;
  },

  getCommunication(id) {
    return normalizeCommunication(get(this.db, 'SELECT * FROM communications WHERE id = ?', [id]));
  },

  listCommunications(taskRunId) {
    return all(
      this.db,
      `SELECT * FROM communications
       WHERE task_run_id = ?
       ORDER BY created_at ASC`,
      [taskRunId],
    ).map(normalizeCommunication);
  },

  agentStatuses({ userId = '', workspaceId = '', allWorkspaces = false } = {}) {
    const taskWhere = ["node.agent_id != ''"];
    const taskParams = [];
    if (userId) { taskWhere.push("task.owner_user_id IN (?, '')"); taskParams.push(userId); }
    if (userId && !allWorkspaces) {
      taskWhere.push('task.account_workspace_id = ?');
      taskParams.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal');
    }
    const nodes = all(this.db, `SELECT node.*,task.status AS task_run_status
      FROM task_nodes node JOIN task_runs task ON task.id=node.task_run_id
      WHERE ${taskWhere.join(' AND ')}`, taskParams)
      .map((row) => ({ ...normalizeTaskNode(row), taskRunStatus: row.task_run_status || '' }));
    const completedByTask = new Map();
    for (const node of nodes) {
      if (node.status !== 'completed') continue;
      const completed = completedByTask.get(node.taskRunId) || new Set();
      completed.add(node.id);
      completedByTask.set(node.taskRunId, completed);
    }
    const communicationWhere = ["communication.status = 'open'", "task.status NOT IN ('completed','failed','cancelled')"];
    const communicationParams = [];
    if (userId) { communicationWhere.push("task.owner_user_id IN (?, '')"); communicationParams.push(userId); }
    if (userId && !allWorkspaces) {
      communicationWhere.push('task.account_workspace_id = ?');
      communicationParams.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal');
    }
    const openComms = all(this.db, `SELECT communication.to_agent_id AS agent_id,COUNT(*) AS count
      FROM communications communication JOIN task_runs task ON task.id=communication.task_run_id
      WHERE ${communicationWhere.join(' AND ')} GROUP BY communication.to_agent_id`, communicationParams);
    const openMap = new Map(openComms.map((row) => [row.agent_id, Number(row.count || 0)]));
    const rowMap = new Map();
    const ensureRow = (agentId) => {
      if (!rowMap.has(agentId)) {
        rowMap.set(agentId, {
          agent_id: agentId,
          ready_count: 0,
          queued_count: 0,
          pending_count: 0,
          running_count: 0,
          waiting_count: 0,
          blocked_count: 0,
          failed_count: 0,
          completed_count: 0,
          cancelled_count: 0,
          active_failed_count: 0,
          active_completed_count: 0,
        });
      }
      return rowMap.get(agentId);
    };
    for (const node of nodes) {
      const row = ensureRow(node.agentId);
      const activeTask = !TERMINAL_AGENT_STATUS_TASKS.has(String(node.taskRunStatus || ''));
      if (!activeTask) {
        if (node.status === 'failed') row.failed_count += 1;
        else if (node.status === 'completed') row.completed_count += 1;
        else if (node.status === 'cancelled') row.cancelled_count += 1;
        continue;
      }
      if (node.status === 'running') row.running_count += 1;
      else if (node.status === 'queued') row.queued_count += 1;
      else if (['waiting', 'retry_wait'].includes(node.status)) row.waiting_count += 1;
      else if (node.status === 'blocked') row.blocked_count += 1;
      else if (node.status === 'failed') { row.failed_count += 1; row.active_failed_count += 1; }
      else if (node.status === 'completed') { row.completed_count += 1; row.active_completed_count += 1; }
      else if (node.status === 'cancelled') row.cancelled_count += 1;
      else if (['pending', 'ready'].includes(node.status)) {
        const completed = completedByTask.get(node.taskRunId) || new Set();
        if ((node.dependencies || []).every((dep) => completed.has(dep))) row.ready_count += 1;
        else row.pending_count += 1;
      }
    }
    for (const row of openComms) {
      ensureRow(row.agent_id);
    }
    return [...rowMap.values()].map((row) => {
      let status = 'idle';
      if (Number(row.blocked_count || 0) > 0) status = 'blocked';
      else if (Number(row.running_count || 0) > 0) status = 'running';
      else if (Number(row.queued_count || 0) > 0) status = 'pending';
      else if (Number(row.ready_count || 0) > 0) status = 'ready';
      else if (Number(row.waiting_count || 0) > 0 || openMap.get(row.agent_id)) status = 'waiting';
      else if (Number(row.active_failed_count || 0) > 0) status = 'failed';
      else if (Number(row.pending_count || 0) > 0) status = 'pending';
      else if (Number(row.active_completed_count || 0) > 0) status = 'completed';
      return {
        agentId: row.agent_id,
        status,
        readyCount: Number(row.ready_count || 0),
        queuedCount: Number(row.queued_count || 0),
        pendingCount: Number(row.pending_count || 0),
        runningCount: Number(row.running_count || 0),
        waitingCount: Number(row.waiting_count || 0),
        blockedCount: Number(row.blocked_count || 0),
        failedCount: Number(row.failed_count || 0),
        completedCount: Number(row.completed_count || 0),
        cancelledCount: Number(row.cancelled_count || 0),
        openCommunicationCount: openMap.get(row.agent_id) || 0,
      };
    });
  },

  createTaskRetrospective({
    taskRunId,
    participants = [],
    assignment = {},
    communications = [],
    waits = [],
    skillFindings = [],
    memoryCandidates = [],
    failurePoints = [],
    finalSummary = '',
  }) {
    const id = newId('retro');
    run(
      this.db,
      `INSERT INTO task_retrospectives (
        id, task_run_id, participants_json, assignment_json, communication_json,
        wait_summary_json, skill_findings_json, memory_candidates_json,
        failure_points_json, final_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_run_id) DO UPDATE SET
        participants_json = excluded.participants_json,
        assignment_json = excluded.assignment_json,
        communication_json = excluded.communication_json,
        wait_summary_json = excluded.wait_summary_json,
        skill_findings_json = excluded.skill_findings_json,
        memory_candidates_json = excluded.memory_candidates_json,
        failure_points_json = excluded.failure_points_json,
        final_summary = excluded.final_summary`,
      [
        id,
        taskRunId,
        JSON.stringify(participants),
        JSON.stringify(assignment),
        JSON.stringify(communications),
        JSON.stringify(waits),
        JSON.stringify(skillFindings),
        JSON.stringify(memoryCandidates),
        JSON.stringify(failurePoints),
        finalSummary,
      ],
    );
    this.upsertMemoryEntry({
      scope: 'task',
      ownerId: taskRunId,
      taskRunId,
      memoryType: 'task_retrospective',
      content: finalSummary,
      lifecycleState: 'active',
      confidence: 0.66,
      sourceKind: 'task_retrospective',
      sourceId: taskRunId,
      reviewStatus: 'task_lead_generated',
    });
    return this.getTaskRetrospective(taskRunId);
  },

  getTaskRetrospective(taskRunId) {
    return normalizeTaskRetrospective(get(this.db, 'SELECT * FROM task_retrospectives WHERE task_run_id = ?', [taskRunId]));
  }


  });
}

function terminalTaskEvidenceSourceKind(status = '') {
  return ({
    completed: 'task_result',
    accepted: 'task_acceptance',
    rework: 'task_rework',
    failed: 'task_failure',
    blocked: 'task_blocked',
    cancelled: 'task_cancelled',
  })[String(status || '').trim()] || '';
}

function mergeTaskProcessEventPayload(previous = {}, incoming = {}) {
  const before = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const detail = String(next.detail || '');
  const output = String(next.output || '');
  const reasoningText = String(next.reasoningText || '');
  const terminalInput = String(next.terminalInput || '');
  return {
    ...before,
    ...next,
    status: String(next.status || before.status || ''),
    detail: next.append
      ? clipTaskEventText(`${before.detail || ''}${detail}`, 4000)
      : clipTaskEventText(detail || before.detail || '', 4000),
    command: clipTaskEventText(String(next.command || before.command || ''), 4000),
    output: next.appendOutput
      ? clipTaskEventText(`${before.output || ''}${output}`, 12_000)
      : clipTaskEventText(output || before.output || '', 12_000),
    cwd: clipTaskEventText(String(next.cwd || before.cwd || ''), 1600),
    reasoningText: next.appendReasoningText
      ? clipTaskEventText(`${before.reasoningText || ''}${reasoningText}`, 12_000)
      : clipTaskEventText(reasoningText || before.reasoningText || '', 12_000),
    terminalInput: next.appendTerminalInput
      ? clipTaskEventText(`${before.terminalInput || ''}${terminalInput}`, 4_000)
      : clipTaskEventText(terminalInput || before.terminalInput || '', 4_000),
    protocolEvents: mergeTaskProtocolEvents(before.protocolEvents, next.protocolEvents),
  };
}

function taskProcessEventIsLocalPrivate({ command = '', output = '', payload = {} } = {}) {
  if (command || output) return true;
  const activityType = String(payload?.activityType || '');
  if (['command', 'tool', 'file'].includes(activityType)) return true;
  return [
    'cwd', 'terminalInput', 'protocolEvents', 'arguments', 'result', 'error', 'appContext', 'prompt',
    'rawResponse', 'commandActions', 'changes', 'diff', 'path', 'searchResults', 'questions',
    'permissions', 'verifications', 'safetyBuffering',
  ].some((key) => taskProcessValuePresent(payload?.[key]));
}

function taskProcessValuePresent(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function mergeTaskProtocolEvents(previous = [], incoming = []) {
  const merged = [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])];
  const seen = new Set();
  return merged.filter((event) => {
    const key = String(event?.protocolEventId || [
      event?.threadId || '', event?.turnId || '', event?.itemId || '', event?.method || '',
      event?.receivedAtMs ?? '', event?.sequence ?? '',
    ].join(':'));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-200);
}

function clipTaskEventText(value = '', limit = 4000) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  const half = Math.max(1, Math.floor((limit - 32) / 2));
  return `${text.slice(0, half).trimEnd()}\n[...clipped...]\n${text.slice(-half).trimStart()}`;
}

function taskLifecycleEvidenceSourceKind(eventType='') {
  if(eventType==='task_created')return 'task_created';
  if(eventType==='task_assigned')return 'task_assigned';
  if(eventType==='task_dependency_changed')return 'task_dependency_changed';
  if(String(eventType).startsWith('graph_'))return 'task_revision';
  return '';
}

function recordTaskLifecycleEventOutbox(store,{event}={}) {
  const sourceKind=taskLifecycleEvidenceSourceKind(event?.eventType);if(!sourceKind)return null;
  const taskRun=get(store.db,'SELECT * FROM task_runs WHERE id=?',[event.taskRunId]);
  const node=event.taskNodeId?get(store.db,'SELECT * FROM task_nodes WHERE id=?',[event.taskNodeId]):null;
  const agentInstanceId=node?.agent_instance_id||taskRun?.lead_agent_instance_id||event.payload?.agentInstanceId||'';
  const instance=agentInstanceId?store.getUserAgentInstance?.(agentInstanceId):null;
  if(!instance||!taskRun||taskRun.owner_user_id!==instance.userId)return null;
  const snapshot={content:[event.summary,JSON.stringify(event.payload||{})].filter(Boolean).join('\n\n'),eventType:event.eventType,
    taskRunId:event.taskRunId,taskNodeId:event.taskNodeId||'',eventPayload:event.payload||{},occurredAt:event.createdAt||nowIso()};
  return store.recordEvolutionEvidenceOutbox({localUserId:instance.userId,userAgentInstanceId:instance.id,agentFamilyId:instance.agentFamilyId,
    sourceKind,sourceId:event.taskNodeId||event.taskRunId,sourceVersionId:event.id,contentHash:sha256Text(snapshot.content),
    taskRunId:event.taskRunId,confidence:0.8,privacyLevel:'owner_private',createdAt:event.createdAt||nowIso(),snapshot});
}

function recordTaskEventOutbox(store, { taskNode, event } = {}) {
  if (!taskNode || !event) return null;
  const sourceKind = terminalTaskEvidenceSourceKind(taskNode.status);
  if (!sourceKind || !taskNode.agentInstanceId) return null;
  const instance = store.getUserAgentInstance?.(taskNode.agentInstanceId);
  const taskRun = get(store.db, 'SELECT * FROM task_runs WHERE id=?', [taskNode.taskRunId]);
  if (!instance || !taskRun || taskRun.owner_user_id !== instance.userId) return null;
  const taskMetadata = safeJsonParse(taskRun.metadata_json, {});
  const context = get(store.db, `SELECT id FROM agent_context_spaces
    WHERE account_workspace_id=? AND user_agent_instance_id=? AND task_run_id=? AND lifecycle_state='active'
    ORDER BY updated_at DESC,id DESC LIMIT 1`, [taskRun.account_workspace_id || 'workspace_personal', instance.id, taskNode.taskRunId]);
  const content = [
    taskNode.title,
    taskNode.objective,
    taskNode.resultSummary,
    taskNode.resultText,
    taskNode.errorText,
    taskNode.waitReason,
    `status: ${taskNode.status}`,
  ].map((value) => String(value || '').trim()).filter(Boolean).join('\n\n');
  const snapshot = {
    content,
    status: taskNode.status,
    title: taskNode.title || '',
    objective: taskNode.objective || '',
    resultText: taskNode.resultText || '',
    resultSummary: taskNode.resultSummary || '',
    evidenceRefs: taskNode.evidenceRefs || [],
    errorText: taskNode.errorText || '',
    waitReason: taskNode.waitReason || '',
    departmentId: taskNode.departmentId || '',
    taskRunId: taskNode.taskRunId,
    taskNodeId: taskNode.id,
    taskEventId: event.id,
    eventType: event.eventType,
    eventSummary: event.summary || '',
    eventPayload: event.payload || {},
    occurredAt: event.createdAt || taskNode.completedAt || taskNode.updatedAt || nowIso(),
  };
  return store.recordEvolutionEvidenceOutbox({
    localUserId: instance.userId,
    userAgentInstanceId: instance.id,
    agentFamilyId: instance.agentFamilyId,
    sourceKind,
    sourceId: taskNode.id,
    sourceVersionId: event.id,
    contentHash: sha256Text(content || JSON.stringify(snapshot)),
    contextSpaceId: context?.id || '',
    taskRunId: taskNode.taskRunId,
    delegationId: String(taskMetadata.delegationId || taskMetadata.delegation_id || ''),
    confidence: taskNode.status === 'accepted' ? 1 : 0.9,
    privacyLevel: 'owner_private',
    createdAt: event.createdAt || taskNode.updatedAt || nowIso(),
    snapshot,
  });
}
