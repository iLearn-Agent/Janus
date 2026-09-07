import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';

const WORK_VISIBILITIES = new Set([
  'agent_private',
  'work_collaborators',
  'work_leadership',
  'work_participants',
  'work_summary',
  'owner_private',
]);
const CLOUD_WORK_VISIBILITIES = new Set(['work_collaborators', 'work_leadership', 'work_participants', 'work_summary']);
const PARTICIPANT_ROLES = new Set(['executor', 'task_lead', 'team_lead', 'cross_team_lead', 'observer', 'auditor']);
const LEADERSHIP_ROLES = new Set(['task_lead', 'team_lead', 'cross_team_lead']);

export function taskWorkScopeId(taskRunId = '') {
  const id = String(taskRunId || '').trim();
  if (!id) throw workMemoryError('WORK_SCOPE_REQUIRED', 'Task work scope requires taskRunId.');
  return `task:${id}`;
}

export function installWorkMemoryAccessStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureTaskWorkScope({
      taskRunId = '',
      parentWorkScopeId = '',
      revisionId = '',
      federationType = '',
      federationId = '',
    } = {}) {
      const task = get(this.db, 'SELECT * FROM task_runs WHERE id = ?', [taskRunId]);
      if (!task) throw workMemoryError('WORK_SOURCE_NOT_FOUND', 'Task run not found.');
      const workScopeId = taskWorkScopeId(taskRunId);
      const now = nowIso();
      const status = terminalTaskStatus(task.status) ? 'closed' : 'active';
      const federation = resolveTaskFederation(task, { federationType, federationId, parentWorkScopeId });
      if (federation.type && federation.id) {
        const existingFederation = get(this.db, `SELECT * FROM work_scopes
          WHERE federation_type = ? AND federation_id = ? AND id != ?`, [federation.type, federation.id, workScopeId]);
        if (existingFederation) {
          const existingTask = existingFederation.scope_type === 'task_run'
            ? get(this.db, 'SELECT status FROM task_runs WHERE id = ?', [existingFederation.source_id])
            : null;
          const replaceable = existingFederation.status === 'closed' || terminalTaskStatus(existingTask?.status);
          if (!replaceable) {
            throw workMemoryError('WORK_FEDERATION_ACTIVE', 'An active work scope already owns this federation.');
          }
          run(this.db, `UPDATE work_scopes SET federation_type = '', federation_id = '', updated_at = ? WHERE id = ?`, [
            now, existingFederation.id,
          ]);
        }
      }
      run(this.db, `INSERT INTO work_scopes (
        id,scope_type,source_id,parent_work_scope_id,revision_id,owner_user_id,federation_type,federation_id,status,created_at,updated_at
      ) VALUES (?,'task_run',?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET parent_work_scope_id=CASE WHEN excluded.parent_work_scope_id != '' THEN excluded.parent_work_scope_id ELSE work_scopes.parent_work_scope_id END,
        revision_id=CASE WHEN excluded.revision_id != '' THEN excluded.revision_id ELSE work_scopes.revision_id END,
        owner_user_id=excluded.owner_user_id,
        federation_type=CASE WHEN excluded.federation_type != '' THEN excluded.federation_type ELSE work_scopes.federation_type END,
        federation_id=CASE WHEN excluded.federation_id != '' THEN excluded.federation_id ELSE work_scopes.federation_id END,
        status=excluded.status,updated_at=excluded.updated_at`, [
        workScopeId, taskRunId, parentWorkScopeId || '', revisionId || '', task.owner_user_id || '',
        federation.type, federation.id, status, task.created_at || now, now,
      ]);
      seedTaskParticipants(this.db, task, workScopeId, now);
      if (status === 'closed') {
        run(this.db, `UPDATE leadership_assignments SET status='revoked',valid_until=CASE WHEN valid_until='' THEN ? ELSE valid_until END,updated_at=?
          WHERE work_scope_id=? AND status='active'`, [task.completed_at || now, now, workScopeId]);
      }
      return normalizeWorkScope(get(this.db, 'SELECT * FROM work_scopes WHERE id = ?', [workScopeId]));
    },

    getWorkScope(workScopeId = '') {
      return normalizeWorkScope(get(this.db, 'SELECT * FROM work_scopes WHERE id = ?', [workScopeId]));
    },

    upsertWorkParticipant({
      workScopeId = '',
      agentInstanceId = '',
      role = 'executor',
      collaboratorAgentInstanceIds,
      validFrom = '',
      validUntil = '',
      status = 'active',
    } = {}) {
      const scope = requireWorkScope(this.db, workScopeId);
      const instance = requireAgentInstance(this, agentInstanceId);
      const normalizedRole = normalizeParticipantRole(role);
      const now = nowIso();
      const existing = get(this.db, `SELECT * FROM work_participants
        WHERE work_scope_id = ? AND agent_instance_id = ?`, [scope.id, instance.id]);
      const edges = collaboratorAgentInstanceIds === undefined
        ? safeJsonParse(existing?.collaboration_edges_json, [])
        : normalizeAgentIds(collaboratorAgentInstanceIds, instance.id);
      const participantStatus = normalizeParticipantStatus(status);
      run(this.db, `INSERT INTO work_participants (
        id,work_scope_id,user_id,agent_instance_id,agent_family_id,role,collaboration_edges_json,
        valid_from,valid_until,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(work_scope_id,agent_instance_id) DO UPDATE SET
        user_id=excluded.user_id,agent_family_id=excluded.agent_family_id,role=excluded.role,
        collaboration_edges_json=excluded.collaboration_edges_json,
        valid_from=CASE WHEN work_participants.valid_from != '' THEN work_participants.valid_from ELSE excluded.valid_from END,
        valid_until=excluded.valid_until,status=excluded.status,updated_at=excluded.updated_at`, [
        existing?.id || newId('workpart'), scope.id, instance.userId || '', instance.id, instance.agentFamilyId || '',
        normalizedRole, JSON.stringify(edges), validFrom || existing?.valid_from || now,
        validUntil || (participantStatus === 'active' ? '' : existing?.valid_until || now), participantStatus,
        existing?.created_at || now, now,
      ]);
      return normalizeWorkParticipant(get(this.db, `SELECT * FROM work_participants
        WHERE work_scope_id = ? AND agent_instance_id = ?`, [scope.id, instance.id]));
    },

    linkWorkCollaborators({ workScopeId = '', agentInstanceId = '', collaboratorAgentInstanceId = '' } = {}) {
      if (!agentInstanceId || !collaboratorAgentInstanceId || agentInstanceId === collaboratorAgentInstanceId) {
        throw workMemoryError('INVALID_COLLABORATION_EDGE', 'A collaboration edge requires two different Agent instances.');
      }
      const left = requireParticipant(this.db, workScopeId, agentInstanceId);
      const right = requireParticipant(this.db, workScopeId, collaboratorAgentInstanceId);
      const now = nowIso();
      updateParticipantEdges(this.db, left, collaboratorAgentInstanceId, now);
      updateParticipantEdges(this.db, right, agentInstanceId, now);
      return {
        left: normalizeWorkParticipant(get(this.db, 'SELECT * FROM work_participants WHERE id = ?', [left.id])),
        right: normalizeWorkParticipant(get(this.db, 'SELECT * FROM work_participants WHERE id = ?', [right.id])),
      };
    },

    appointWorkLeader({
      workScopeId = '',
      agentInstanceId = '',
      role = 'task_lead',
      leadershipLevelSnapshot = '',
      assignmentMode = 'normal',
      limitSnapshot = {},
      permissionSnapshot = {},
      appointedBy = '',
      validFrom = '',
      validUntil = '',
    } = {}) {
      requireWorkScope(this.db, workScopeId);
      const instance = requireAgentInstance(this, agentInstanceId);
      const normalizedRole = normalizeLeadershipRole(role);
      const now = nowIso();
      const startsAt = validFrom || now;
      this.upsertWorkParticipant({ workScopeId, agentInstanceId: instance.id, role: normalizedRole, validFrom: startsAt });
      run(this.db, `UPDATE leadership_assignments SET status='revoked',valid_until=CASE WHEN valid_until='' THEN ? ELSE valid_until END,updated_at=?
        WHERE work_scope_id=? AND agent_instance_id=? AND status IN ('active','draining')`, [startsAt, now, workScopeId, instance.id]);
      const id = newId('worklead');
      run(this.db, `INSERT INTO leadership_assignments (
        id,work_scope_id,agent_instance_id,role,leadership_level_snapshot,assignment_mode,limit_snapshot_json,permission_snapshot_json,
        appointed_by,valid_from,valid_until,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`, [
        id, workScopeId, instance.id, normalizedRole, String(leadershipLevelSnapshot || ''),
        String(assignmentMode || 'normal') === 'trial' ? 'trial' : 'normal', JSON.stringify(limitSnapshot || {}),
        JSON.stringify(permissionSnapshot || {}), appointedBy || '', startsAt, validUntil || '', now, now,
      ]);
      return normalizeLeadershipAssignment(get(this.db, 'SELECT * FROM leadership_assignments WHERE id = ?', [id]));
    },

    revokeWorkLeader({ workScopeId = '', agentInstanceId = '', revokedAt = '' } = {}) {
      requireWorkScope(this.db, workScopeId);
      const at = revokedAt || nowIso();
      run(this.db, `UPDATE leadership_assignments SET status='revoked',valid_until=CASE WHEN valid_until='' OR valid_until>? THEN ? ELSE valid_until END,updated_at=?
        WHERE work_scope_id=? AND agent_instance_id=? AND status IN ('active','draining')`, [at, at, at, workScopeId, agentInstanceId]);
      return all(this.db, `SELECT * FROM leadership_assignments WHERE work_scope_id=? AND agent_instance_id=?
        ORDER BY created_at DESC`, [workScopeId, agentInstanceId]).map(normalizeLeadershipAssignment);
    },

    getWorkLeadershipAssignment({ workScopeId = '', agentInstanceId = '', at = '' } = {}) {
      requireWorkScope(this.db, workScopeId);
      if (!agentInstanceId) return null;
      return normalizeLeadershipAssignment(findValidLeadership(this.db, workScopeId, agentInstanceId, at || nowIso()));
    },

    listActiveWorkLeadershipAssignments({ agentInstanceId = '', at = '' } = {}) {
      const effectiveAt = at || nowIso();
      return all(this.db, `SELECT a.* FROM leadership_assignments a JOIN work_scopes s ON s.id=a.work_scope_id
        WHERE a.agent_instance_id=? AND a.status='active' AND s.status='active'
        AND a.valid_from<=? AND (a.valid_until='' OR a.valid_until>?) ORDER BY a.created_at DESC`, [agentInstanceId, effectiveAt, effectiveAt])
        .map(normalizeLeadershipAssignment);
    },

    removeWorkParticipant({ workScopeId = '', agentInstanceId = '', removedAt = '' } = {}) {
      requireWorkScope(this.db, workScopeId);
      const at = removedAt || nowIso();
      run(this.db, `UPDATE work_participants SET status='removed',valid_until=CASE WHEN valid_until='' OR valid_until>? THEN ? ELSE valid_until END,updated_at=?
        WHERE work_scope_id=? AND agent_instance_id=?`, [at, at, at, workScopeId, agentInstanceId]);
      this.revokeWorkLeader({ workScopeId, agentInstanceId, revokedAt: at });
      return normalizeWorkParticipant(get(this.db, `SELECT * FROM work_participants
        WHERE work_scope_id=? AND agent_instance_id=?`, [workScopeId, agentInstanceId]));
    },

    publishWorkMemoryVersion({
      workScopeId = '',
      agentInstanceId = '',
      memoryDocumentId = '',
      visibility = 'work_collaborators',
      content,
      sourceKind = 'work_memory_publish',
      sourceId = '',
      sourceCursor = '',
      reviewStatus = 'work_published',
    } = {}) {
      const scope = requireWorkScope(this.db, workScopeId);
      if (scope.status !== 'active') throw workMemoryError('WORK_SCOPE_CLOSED', 'Closed work is historical and cannot publish new Memory versions.');
      const normalizedVisibility = normalizeWorkVisibility(visibility);
      if (['agent_private', 'owner_private'].includes(normalizedVisibility)) {
        throw workMemoryError('PRIVATE_VISIBILITY_NOT_PUBLISHABLE', 'Private Memory is not a work publication.');
      }
      const document = get(this.db, 'SELECT * FROM memory_documents WHERE id = ?', [memoryDocumentId]);
      if (!document) throw workMemoryError('MEMORY_DOCUMENT_NOT_FOUND', 'Memory document not found.');
      if (document.user_agent_instance_id !== agentInstanceId) {
        throw workMemoryError('CROSS_AGENT_WRITE_FORBIDDEN', 'An Agent may publish only its own Memory.');
      }
      if (document.work_scope_id !== scope.id || document.scope !== 'task') {
        throw workMemoryError('MEMORY_WORK_SCOPE_MISMATCH', 'Memory document does not belong to the exact work scope.');
      }
      const participant = requireParticipant(this.db, scope.id, agentInstanceId);
      if (!participantValidAt(participant, nowIso())) {
        throw workMemoryError('TARGET_NOT_ACTIVE_PARTICIPANT', 'Publishing Agent is not an active work participant.');
      }
      const current = get(this.db, `SELECT * FROM memory_document_versions WHERE id=?`, [document.current_version_id]);
      const published = this.appendMemoryDocumentVersion({
        memoryDocumentId: document.id,
        content: content === undefined ? resolveVersionContent(this, current) : String(content || ''),
        sourceKind,
        sourceId: sourceId || scope.source_id,
        reviewStatus,
        createdBy: document.user_id,
        visibility: normalizedVisibility,
        publishedAt: nowIso(),
        publishedByAgentInstanceId: agentInstanceId,
        sourceCursor,
      });
      const version = normalizePublishedVersion(get(this.db, 'SELECT * FROM memory_document_versions WHERE id=?', [published.currentVersionId]));
      const outbox = scope.federation_type && scope.federation_id
        ? this.enqueueWorkMemoryPublication({
            workScopeId: scope.id,
            memoryDocumentVersionId: version.id,
          })
        : null;
      return {
        document: published,
        version,
        outbox,
      };
    },

    publishTaskMilestone({
      taskRunId = '',
      agentInstanceId = '',
      taskNodeId = '',
      nodeTitle = '',
      status = 'update',
      summary = '',
      visibility = '',
      sourceCursor = '',
    } = {}) {
      const cleanSummary = sanitizeMilestoneSummary(summary);
      if (!taskRunId || !agentInstanceId || !cleanSummary) return null;
      const scope = this.ensureTaskWorkScope({ taskRunId });
      if (scope.status !== 'active') return null;
      const normalizedStatus = normalizeMilestoneStatus(status);
      const sourceId = `${taskNodeId || 'task'}:${normalizedStatus}:${sourceCursor || ''}`;
      const existing = get(this.db, `SELECT mdv.*,md.id AS document_id FROM memory_document_versions mdv
        JOIN memory_documents md ON md.id=mdv.memory_document_id
        WHERE md.work_scope_id=? AND md.user_agent_instance_id=?
          AND mdv.source_kind='task_milestone_publish' AND mdv.source_id=?
        ORDER BY mdv.created_at DESC LIMIT 1`, [scope.id, agentInstanceId, sourceId]);
      if (existing) {
        return {
          document: this.getMemoryDocument(existing.document_id),
          version: normalizePublishedVersion(existing),
          outbox: getOutboxByVersion(this.db, existing.id),
          idempotent: true,
        };
      }
      let document = get(this.db, `SELECT md.id FROM memory_documents md
        WHERE md.work_scope_id=? AND md.user_agent_instance_id=? AND md.scope='task' AND md.slot_no=1000`, [scope.id, agentInstanceId]);
      if (!document) {
        document = this.createMemoryDocument({
          agentInstanceId,
          scope: 'task',
          slotNo: 1000,
          taskRunId,
          contextSpaceId: scope.id,
          displayName: 'work-progress.md',
          content: `# Work Progress\n\nOnly explicitly published task milestones are stored in this document.\n`,
          sourceKind: 'work_milestone_seed',
          sourceId: taskRunId,
          syncEnabled: true,
          allowPersonalEvolution: false,
          allowClusterEvolution: false,
        });
      } else {
        document = this.getMemoryDocument(document.id);
      }
      const at = nowIso();
      const entry = `- ${at} [${normalizedStatus}] ${String(nodeTitle || 'Task').trim().slice(0, 160)}: ${cleanSummary}`;
      const marker = '\n## Published Milestones\n';
      const current = String(document.content || '');
      const next = current.includes(marker)
        ? `${current.trimEnd()}\n${entry}\n`
        : `${current.trimEnd()}${marker}${entry}\n`;
      return this.publishWorkMemoryVersion({
        workScopeId: scope.id,
        agentInstanceId,
        memoryDocumentId: document.id,
        visibility: visibility || milestoneVisibility(normalizedStatus),
        content: next.slice(-24000),
        sourceKind: 'task_milestone_publish',
        sourceId,
        sourceCursor: sourceCursor || at,
        reviewStatus: 'task_milestone_published',
      });
    },

    enqueueWorkMemoryPublication({ workScopeId = '', memoryDocumentVersionId = '' } = {}) {
      const scope = requireWorkScope(this.db, workScopeId);
      if (!scope.federation_type || !scope.federation_id) return null;
      const version = get(this.db, `SELECT mdv.id,md.user_id FROM memory_document_versions mdv
        JOIN memory_documents md ON md.id=mdv.memory_document_id
        WHERE mdv.id=? AND md.work_scope_id=?`, [memoryDocumentVersionId, scope.id]);
      if (!version) throw workMemoryError('MEMORY_WORK_SCOPE_MISMATCH', 'Publication version does not belong to the exact work scope.');
      const now = nowIso();
      run(this.db, `INSERT INTO work_memory_publication_outbox (
        id,user_id,work_scope_id,memory_document_version_id,federation_type,federation_id,
        status,attempt_count,last_error,next_attempt_at,created_at,updated_at,published_at
      ) VALUES (?,?,?,?,?,?,'pending',0,'','',?,?,'')
      ON CONFLICT(memory_document_version_id) DO UPDATE SET
        user_id=excluded.user_id,work_scope_id=excluded.work_scope_id,
        federation_type=excluded.federation_type,federation_id=excluded.federation_id,
        status=CASE WHEN work_memory_publication_outbox.status='published' THEN 'published' ELSE 'pending' END,
        next_attempt_at=CASE WHEN work_memory_publication_outbox.status='published' THEN work_memory_publication_outbox.next_attempt_at ELSE '' END,
        updated_at=excluded.updated_at`, [
        newId('workpub'), version.user_id || scope.owner_user_id || '', scope.id, version.id,
        scope.federation_type, scope.federation_id, now, now,
      ]);
      return normalizePublicationOutbox(get(this.db, 'SELECT * FROM work_memory_publication_outbox WHERE memory_document_version_id=?', [version.id]));
    },

    getWorkMemoryPublicationOutbox({ id = '', memoryDocumentVersionId = '' } = {}) {
      if (!id && !memoryDocumentVersionId) return null;
      return normalizePublicationOutbox(get(this.db, `SELECT * FROM work_memory_publication_outbox
        WHERE (?!='' AND id=?) OR (?!='' AND memory_document_version_id=?)
        ORDER BY created_at LIMIT 1`, [id, id, memoryDocumentVersionId, memoryDocumentVersionId]));
    },

    listWorkMemoryPublicationOutbox({ userId = '', workScopeId = '', status = '', dueOnly = false, limit = 100 } = {}) {
      const where = ['1=1'];
      const params = [];
      if (userId) { where.push('user_id=?'); params.push(userId); }
      if (workScopeId) { where.push('work_scope_id=?'); params.push(workScopeId); }
      if (status) { where.push('status=?'); params.push(status); }
      if (dueOnly) {
        where.push("status IN ('pending','failed')");
        where.push("(next_attempt_at='' OR next_attempt_at<=?)");
        params.push(nowIso());
      }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM work_memory_publication_outbox WHERE ${where.join(' AND ')}
        ORDER BY created_at,id LIMIT ?`, params).map(normalizePublicationOutbox);
    },

    claimWorkMemoryPublication({ id = '' } = {}) {
      const now = nowIso();
      const result = run(this.db, `UPDATE work_memory_publication_outbox SET status='sending',
        attempt_count=attempt_count+1,last_error='',next_attempt_at='',updated_at=?
        WHERE id=? AND status IN ('pending','failed') AND (next_attempt_at='' OR next_attempt_at<=?)`, [now, id, now]);
      return Boolean(result?.changes);
    },

    completeWorkMemoryPublication({ id = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE work_memory_publication_outbox SET status='published',last_error='',
        next_attempt_at='',published_at=?,updated_at=? WHERE id=? AND status='sending'`, [now, now, id]);
      return normalizePublicationOutbox(get(this.db, 'SELECT * FROM work_memory_publication_outbox WHERE id=?', [id]));
    },

    failWorkMemoryPublication({ id = '', error = '', retryAt = '' } = {}) {
      run(this.db, `UPDATE work_memory_publication_outbox SET status='failed',last_error=?,
        next_attempt_at=?,updated_at=? WHERE id=? AND status='sending'`, [String(error || '').slice(0, 2000), retryAt || '', nowIso(), id]);
      return normalizePublicationOutbox(get(this.db, 'SELECT * FROM work_memory_publication_outbox WHERE id=?', [id]));
    },

    recoverStaleWorkMemoryPublications({ userId = '', staleBefore = '' } = {}) {
      if (!staleBefore) return 0;
      const params = [nowIso(), staleBefore];
      let userFilter = '';
      if (userId) {
        userFilter = ' AND user_id=?';
        params.push(userId);
      }
      const result = run(this.db, `UPDATE work_memory_publication_outbox SET status='failed',
        last_error='publication lease expired',next_attempt_at='',updated_at=?
        WHERE status='sending' AND updated_at<=?${userFilter}`, params);
      return Number(result?.changes || 0);
    },

    recordWorkMemoryAccessDecision(input = {}) {
      recordWorkMemoryAudit(this.db, input);
    },

    listWorkParticipantProgress({ workScopeId = '', requesterAgentInstanceId = '' } = {}) {
      const scope = requireWorkScope(this.db, workScopeId);
      const requester = requireParticipant(this.db, scope.id, requesterAgentInstanceId);
      if (!participantValidAt(requester, nowIso())) {
        throw workMemoryError('REQUESTER_NOT_ACTIVE_PARTICIPANT', 'Requester is not an active work participant.');
      }
      return all(this.db, `SELECT wp.*,tn.status AS node_status,tn.title AS node_title,
          tn.result_summary AS node_result_summary,tn.wait_reason AS node_wait_reason,tn.updated_at AS node_updated_at
        FROM work_participants wp
        LEFT JOIN task_nodes tn ON ?='task_run' AND tn.task_run_id=? AND tn.agent_instance_id=wp.agent_instance_id
        WHERE wp.work_scope_id=?
        ORDER BY wp.created_at,tn.priority,tn.created_at`, [scope.scope_type, scope.source_id, scope.id]).map((row) => ({
        agentInstanceId: row.agent_instance_id,
        agentFamilyId: row.agent_family_id || '',
        role: row.role,
        participantStatus: row.status,
        node: row.node_title ? {
          title: row.node_title,
          status: row.node_status,
          resultSummary: row.node_result_summary || '',
          waitReason: row.node_wait_reason || '',
          updatedAt: row.node_updated_at || '',
        } : null,
      }));
    },

    latestCollaboratorWorkMemoryReference({ workScopeId = '', targetAgentInstanceId = '' } = {}) {
      requireWorkScope(this.db, workScopeId);
      if (!targetAgentInstanceId) throw workMemoryError('AGENT_ID_REQUIRED', 'Target Agent instance ID is required.');
      const row = get(this.db, `SELECT md.id AS memory_document_id,mdv.id AS memory_document_version_id,
          mdv.visibility,mdv.published_at,mdv.source_cursor
        FROM memory_document_versions mdv
        JOIN memory_documents md ON md.id=mdv.memory_document_id
        WHERE md.work_scope_id=? AND md.user_agent_instance_id=? AND md.scope='task'
          AND mdv.published_at!='' AND mdv.visibility IN ('work_summary','work_participants')
        ORDER BY CASE mdv.visibility WHEN 'work_summary' THEN 0 ELSE 1 END,
          mdv.published_at DESC,mdv.created_at DESC LIMIT 1`, [workScopeId, targetAgentInstanceId]);
      if (!row) return null;
      return {
        workScopeId,
        targetAgentInstanceId,
        memoryDocumentId: row.memory_document_id,
        memoryDocumentVersionId: row.memory_document_version_id,
        visibility: row.visibility,
        publishedAt: row.published_at,
        sourceCursor: row.source_cursor || '',
      };
    },

    readCollaboratorWorkMemory({
      workScopeId = '',
      requesterAgentInstanceId = '',
      targetAgentInstanceId = '',
      memoryDocumentId = '',
      memoryDocumentVersionId = '',
      reason = '',
    } = {}) {
      const audit = {
        requesterAgentInstanceId,
        targetAgentInstanceId,
        workScopeId,
        memoryDocumentId,
        memoryDocumentVersionId,
        reason,
      };
      try {
        if (!workScopeId) throw workMemoryError('WORK_SCOPE_REQUIRED', 'Exact workScopeId is required.');
        if (!requesterAgentInstanceId || !targetAgentInstanceId) {
          throw workMemoryError('AGENT_ID_REQUIRED', 'Requester and target Agent instance IDs are required.');
        }
        if (requesterAgentInstanceId === targetAgentInstanceId) {
          throw workMemoryError('SELF_READ_NOT_COLLABORATION', 'Use the owning Agent Memory API for self reads.');
        }
        const scope = requireWorkScope(this.db, workScopeId);
        const requesterInstance = requireAgentInstance(this, requesterAgentInstanceId);
        const targetInstance = requireAgentInstance(this, targetAgentInstanceId);
        audit.requesterUserId = requesterInstance.userId || '';
        audit.targetUserId = targetInstance.userId || '';
        if (requesterInstance.userId !== targetInstance.userId) {
          throw workMemoryError('CLOUD_AUTH_REQUIRED', 'Cross-user work Memory reads require cloud/uBuddy authorization.');
        }
        const document = resolveExactWorkDocument(this.db, {
          workScopeId: scope.id,
          targetAgentInstanceId,
          memoryDocumentId,
        });
        audit.memoryDocumentId = document.id;
        const version = resolveExactWorkVersion(this.db, document, memoryDocumentVersionId);
        audit.memoryDocumentVersionId = version.id;
        const visibility = normalizeStoredVisibility(version.visibility || document.visibility);
        if (!version.published_at || ['agent_private', 'owner_private'].includes(visibility)) {
          throw workMemoryError('MEMORY_PRIVATE', 'The requested Memory version is private.');
        }
        const effectiveAt = version.published_at || version.created_at;
        const requester = requireParticipant(this.db, scope.id, requesterAgentInstanceId);
        const target = requireParticipant(this.db, scope.id, targetAgentInstanceId);
        audit.requesterRoleSnapshot = requester.role;
        if (!participantValidAt(requester, effectiveAt)) {
          throw workMemoryError('REQUESTER_OUTSIDE_MEMBERSHIP_WINDOW', 'Requester was not a participant when this version was published.');
        }
        if (!participantValidAt(target, effectiveAt)) {
          throw workMemoryError('TARGET_OUTSIDE_MEMBERSHIP_WINDOW', 'Target was not a participant when this version was published.');
        }
        const leadership = findValidLeadership(this.db, scope.id, requesterAgentInstanceId, effectiveAt);
        if (leadership) {
          const projection = get(this.db, 'SELECT payload_json,updated_at FROM cloud_stage8_projections WHERE projection_key=?', [`leadership:${requesterAgentInstanceId}`]);
          const currentLeadership = safeJsonParse(projection?.payload_json, null);
          if (currentLeadership && currentLeadership.status !== 'active') {
            throw workMemoryError('LEADERSHIP_NOT_ACTIVE', 'Current Leadership authority is not active.');
          }
          const currentLevel = Number(String(currentLeadership?.level || 'L0').replace(/^L/i, '')) || 0;
          const assignedLevel = Number(String(leadership.leadership_level_snapshot || 'L0').replace(/^L/i, '')) || 0;
          const projectionAgeMs = Date.now() - Date.parse(projection?.updated_at || '');
          if (currentLeadership && currentLevel < assignedLevel && (!Number.isFinite(projectionAgeMs) || projectionAgeMs > 24 * 3600000)) {
            throw workMemoryError('LEADERSHIP_DRAINING_EXPIRED', 'Leadership draining window has expired.');
          }
        }
        audit.leadershipAssignment = leadership;
        authorizeVisibility({ visibility, requester, target, leadership, reason });
        recordWorkMemoryAudit(this.db, { ...audit, result: 'allowed', resultCode: 'ALLOWED' });
        return {
          workScopeId: scope.id,
          targetAgentInstanceId,
          memoryDocumentId: document.id,
          memoryDocumentVersionId: version.id,
          versionNo: Number(version.version_no || 0),
          visibility,
          content: resolveVersionContent(this, version),
          contentHash: version.content_hash || '',
          sourceCursor: version.source_cursor || '',
          publishedAt: version.published_at,
          createdAt: version.created_at,
        };
      } catch (error) {
        const code = error?.code || 'WORK_MEMORY_ACCESS_DENIED';
        recordWorkMemoryAudit(this.db, { ...audit, result: 'denied', resultCode: code });
        throw error;
      }
    },

    listWorkMemoryAccessAudits({ workScopeId = '', requesterAgentInstanceId = '', limit = 200 } = {}) {
      const where = ['1=1'];
      const params = [];
      if (workScopeId) { where.push('work_scope_id=?'); params.push(workScopeId); }
      if (requesterAgentInstanceId) { where.push('requester_agent_instance_id=?'); params.push(requesterAgentInstanceId); }
      params.push(Math.max(1, Math.min(1000, Number(limit || 200))));
      return all(this.db, `SELECT * FROM work_memory_access_audits WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC,id DESC LIMIT ?`, params).map(normalizeWorkMemoryAudit);
    },

    cloudWorkMemoryPublication({ memoryDocumentVersionId = '', keyring = null } = {}) {
      if (!memoryDocumentVersionId) {
        throw workMemoryError('MEMORY_VERSION_REQUIRED', 'A published Memory version is required for cloud publication.');
      }
      const row = get(this.db, `SELECT mdv.*,md.user_id AS document_user_id,
          md.user_agent_instance_id AS document_agent_instance_id,md.scope AS document_scope,
          md.task_run_id,md.work_scope_id,ws.federation_type,ws.federation_id,
          wp.role AS participant_role,wp.collaboration_edges_json
        FROM memory_document_versions mdv
        JOIN memory_documents md ON md.id=mdv.memory_document_id
        JOIN work_scopes ws ON ws.id=md.work_scope_id
        LEFT JOIN work_participants wp ON wp.work_scope_id=ws.id
          AND wp.agent_instance_id=md.user_agent_instance_id
        WHERE mdv.id=?`, [memoryDocumentVersionId]);
      if (!row) throw workMemoryError('MEMORY_VERSION_NOT_FOUND', 'Memory version not found.');
      const federation = normalizeFederation(row.federation_type, row.federation_id);
      if (!federation.id) throw workMemoryError('WORK_FEDERATION_REQUIRED', 'Work scope is not linked to a delegation or collaboration group.');
      const visibility = normalizeStoredVisibility(row.visibility);
      if (!row.published_at || !CLOUD_WORK_VISIBILITIES.has(visibility)) {
        throw workMemoryError('WORK_MEMORY_NOT_PUBLISHED', 'Only explicitly published work-visible Memory versions may be sent to cloud.');
      }
      if (!row.published_by_agent_instance_id || row.published_by_agent_instance_id !== row.document_agent_instance_id) {
        throw workMemoryError('MEMORY_PUBLISHER_MISMATCH', 'Published Memory must be owned by the publishing Agent.');
      }
      if (row.document_scope !== 'task' || !row.task_run_id || row.work_scope_id !== taskWorkScopeId(row.task_run_id)) {
        throw workMemoryError('MEMORY_WORK_SCOPE_MISMATCH', 'Cloud work publication must belong to the exact task work scope.');
      }
      const security = this.prepareTaskCloudCollaborationEnvelope({ taskRunId: row.task_run_id, keyring });
      if (security.cloudEnvelopeState !== 'active' || !security.cloudWrappedKey) {
        throw workMemoryError('CLOUD_KEY_ENVELOPE_UNAVAILABLE', 'Cloud task key envelope is not available yet.');
      }
      if (!row.encryption_algorithm || !row.content_ciphertext || !row.content_nonce || !row.content_tag) {
        throw workMemoryError('WORK_MEMORY_CIPHERTEXT_REQUIRED', 'Cloud work publication requires encrypted task Memory content.');
      }
      return {
        federationType: federation.type,
        federationId: federation.id,
        participant: {
          role: normalizeParticipantRole(row.participant_role || 'executor'),
          collaborationAgentInstanceIds: normalizeAgentIds(safeJsonParse(row.collaboration_edges_json, []), row.document_agent_instance_id),
        },
        version: {
          id: row.id,
          agentInstanceId: row.document_agent_instance_id,
          memoryDocumentId: row.memory_document_id,
          memoryDocumentVersionId: row.id,
          versionNo: Number(row.version_no || 1),
          visibility,
          contentHash: row.content_hash || '',
          sourceCursor: row.source_cursor || '',
          encryptionAlgorithm: row.encryption_algorithm,
          encryptionKeyVersion: Number(row.encryption_key_version || security.keyVersion || 1),
          contentCiphertext: row.content_ciphertext,
          contentNonce: row.content_nonce,
          contentTag: row.content_tag,
          contentAad: row.content_aad || '',
          cloudWrapAlgorithm: security.cloudWrapAlgorithm,
          cloudWrappingKeyId: security.cloudWrappingKeyId,
          cloudWrappedKey: security.cloudWrappedKey,
          publishedAt: row.published_at,
        },
      };
    },
  });
}

function seedTaskParticipants(db, task, workScopeId, now) {
  const participants = new Map();
  const taskMetadata = safeJsonParse(task.metadata_json, {});
  const appointedLeadership = taskMetadata.leadershipAssessmentEligible === true
    || (!Object.hasOwn(taskMetadata, 'coordinationMode') && Boolean(task.lead_agent_instance_id));
  if (task.lead_agent_instance_id) participants.set(task.lead_agent_instance_id, appointedLeadership ? taskMetadata.leadershipRole || 'task_lead' : 'executor');
  for (const row of all(db, `SELECT DISTINCT agent_instance_id FROM task_nodes
    WHERE task_run_id=? AND agent_instance_id!=''`, [task.id])) {
    if (!participants.has(row.agent_instance_id)) participants.set(row.agent_instance_id, 'executor');
  }
  for (const [agentInstanceId, role] of participants) {
    const instance = get(db, 'SELECT * FROM user_agent_instances WHERE id=?', [agentInstanceId]);
    if (!instance) continue;
    rawUpsertParticipant(db, {
      workScopeId,
      instance,
      role,
      validFrom: task.created_at || now,
      now,
    });
  }
  if (task.lead_agent_instance_id && appointedLeadership) {
    const existing = get(db, `SELECT id FROM leadership_assignments
      WHERE work_scope_id=? AND agent_instance_id=? AND status='active'`, [workScopeId, task.lead_agent_instance_id]);
    if (!existing) {
      run(db, `INSERT INTO leadership_assignments (
        id,work_scope_id,agent_instance_id,role,leadership_level_snapshot,assignment_mode,limit_snapshot_json,permission_snapshot_json,
        appointed_by,valid_from,valid_until,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'{}','task_orchestration',?,'','active',?,?)`, [
        taskMetadata.leadershipAssignmentId || newId('worklead'), workScopeId, task.lead_agent_instance_id,
        taskMetadata.leadershipRole || 'task_lead', taskMetadata.leadershipLevelSnapshot || 'L0',
        taskMetadata.leadershipAssignmentMode === 'trial' ? 'trial' : 'normal', JSON.stringify(taskMetadata.leadershipLimitSnapshot || {}),
        task.created_at || now, now, now,
      ]);
    }
  }
}

function rawUpsertParticipant(db, { workScopeId, instance, role, validFrom, now }) {
  const existing = get(db, `SELECT * FROM work_participants WHERE work_scope_id=? AND agent_instance_id=?`, [workScopeId, instance.id]);
  run(db, `INSERT INTO work_participants (
    id,work_scope_id,user_id,agent_instance_id,agent_family_id,role,collaboration_edges_json,
    valid_from,valid_until,status,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,'[]',?,'','active',?,?)
  ON CONFLICT(work_scope_id,agent_instance_id) DO UPDATE SET
    user_id=excluded.user_id,agent_family_id=excluded.agent_family_id,
    role=CASE WHEN work_participants.role IN ('task_lead','team_lead','cross_team_lead') THEN work_participants.role ELSE excluded.role END,
    updated_at=excluded.updated_at`, [
    existing?.id || newId('workpart'), workScopeId, instance.user_id || '', instance.id, instance.agent_family_id || '',
    role, existing?.valid_from || validFrom, existing?.created_at || now, now,
  ]);
}

function resolveExactWorkDocument(db, { workScopeId, targetAgentInstanceId, memoryDocumentId }) {
  if (memoryDocumentId) {
    const row = get(db, `SELECT * FROM memory_documents WHERE id=? AND work_scope_id=? AND user_agent_instance_id=?`, [
      memoryDocumentId, workScopeId, targetAgentInstanceId,
    ]);
    if (!row) throw workMemoryError('MEMORY_WORK_SCOPE_MISMATCH', 'Memory document does not match the exact work scope and target Agent.');
    return row;
  }
  const rows = all(db, `SELECT * FROM memory_documents WHERE work_scope_id=? AND user_agent_instance_id=? AND scope='task'
    ORDER BY slot_no,created_at`, [workScopeId, targetAgentInstanceId]);
  if (!rows.length) throw workMemoryError('MEMORY_DOCUMENT_NOT_FOUND', 'No Memory document exists for the target Agent in this work scope.');
  if (rows.length > 1) throw workMemoryError('MEMORY_DOCUMENT_REQUIRED', 'memoryDocumentId is required when multiple exact work documents exist.');
  return rows[0];
}

function resolveExactWorkVersion(db, document, versionId) {
  const id = versionId || document.current_version_id;
  const version = get(db, `SELECT * FROM memory_document_versions WHERE id=? AND memory_document_id=?`, [id, document.id]);
  if (!version) throw workMemoryError('MEMORY_VERSION_NOT_FOUND', 'Memory version not found in the exact document.');
  return version;
}

function resolveVersionContent(store, version) {
  if (!version) return '';
  try {
    return store.decryptMemoryVersionContent?.(version) ?? version.content ?? '';
  } catch {
    throw workMemoryError('MEMORY_DECRYPTION_UNAVAILABLE', 'Memory version cannot be decrypted on this device.');
  }
}

function authorizeVisibility({ visibility, requester, target, leadership, reason }) {
  if (leadership) {
    if (leadership.role === 'cross_team_lead' && visibility !== 'work_summary' && !String(reason || '').trim()) {
      throw workMemoryError('ACCESS_REASON_REQUIRED', 'Cross-team leadership detail reads require a reason.');
    }
    return;
  }
  if (visibility === 'work_collaborators') {
    const edges = new Set(safeJsonParse(requester.collaboration_edges_json, []));
    if (!edges.has(target.agent_instance_id)) {
      throw workMemoryError('NOT_DIRECT_COLLABORATOR', 'Requester is not a direct collaborator of the target Agent.');
    }
    return;
  }
  if (visibility === 'work_leadership') {
    throw workMemoryError('LEADERSHIP_APPOINTMENT_REQUIRED', 'A valid work leadership appointment is required.');
  }
  if (visibility === 'work_participants' || visibility === 'work_summary') return;
  throw workMemoryError('UNSUPPORTED_WORK_VISIBILITY', `Unsupported work Memory visibility: ${visibility}`);
}

function findValidLeadership(db, workScopeId, agentInstanceId, at) {
  return get(db, `SELECT * FROM leadership_assignments
    WHERE work_scope_id=? AND agent_instance_id=? AND valid_from<=?
      AND (valid_until='' OR valid_until>=?) AND status IN ('active','draining','revoked')
    ORDER BY valid_from DESC,created_at DESC LIMIT 1`, [workScopeId, agentInstanceId, at, at]);
}

function participantValidAt(participant, at) {
  if (!participant || !at || !participant.valid_from || participant.valid_from > at) return false;
  return !participant.valid_until || participant.valid_until >= at;
}

function recordWorkMemoryAudit(db, input) {
  try {
    run(db, `INSERT INTO work_memory_access_audits (
      id,requester_user_id,requester_agent_instance_id,target_user_id,target_agent_instance_id,
      work_scope_id,memory_document_id,memory_document_version_id,requested_reason,
      requester_role_snapshot,leadership_assignment_snapshot_json,result,result_code,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      newId('workmemaudit'), input.requesterUserId || '', input.requesterAgentInstanceId || '',
      input.targetUserId || '', input.targetAgentInstanceId || '', input.workScopeId || '',
      input.memoryDocumentId || '', input.memoryDocumentVersionId || '', String(input.reason || '').slice(0, 1000),
      input.requesterRoleSnapshot || '', JSON.stringify(input.leadershipAssignment || {}),
      input.result, input.resultCode, nowIso(),
    ]);
  } catch {
    // Authorization errors must remain primary even if an audit sink is unavailable.
  }
}

function updateParticipantEdges(db, participant, collaboratorId, now) {
  const edges = normalizeAgentIds([...safeJsonParse(participant.collaboration_edges_json, []), collaboratorId], participant.agent_instance_id);
  run(db, 'UPDATE work_participants SET collaboration_edges_json=?,updated_at=? WHERE id=?', [JSON.stringify(edges), now, participant.id]);
}

function requireWorkScope(db, workScopeId) {
  if (!workScopeId) throw workMemoryError('WORK_SCOPE_REQUIRED', 'Exact workScopeId is required.');
  const scope = get(db, 'SELECT * FROM work_scopes WHERE id=?', [workScopeId]);
  if (!scope) throw workMemoryError('WORK_SCOPE_NOT_FOUND', 'Work scope not found.');
  return scope;
}

function requireParticipant(db, workScopeId, agentInstanceId) {
  const participant = get(db, `SELECT * FROM work_participants WHERE work_scope_id=? AND agent_instance_id=?`, [workScopeId, agentInstanceId]);
  if (!participant) throw workMemoryError('WORK_PARTICIPANT_REQUIRED', 'Agent is not assigned to the exact work scope.');
  return participant;
}

function requireAgentInstance(store, agentInstanceId) {
  const instance = store.getUserAgentInstance?.(agentInstanceId);
  if (!instance) throw workMemoryError('AGENT_INSTANCE_NOT_FOUND', 'User Agent instance not found.');
  return instance;
}

function normalizeParticipantRole(value) {
  const role = String(value || 'executor').trim().toLowerCase();
  if (!PARTICIPANT_ROLES.has(role)) throw workMemoryError('INVALID_WORK_ROLE', `Unsupported work role: ${role}`);
  return role;
}

function normalizeLeadershipRole(value) {
  const role = normalizeParticipantRole(value);
  if (!LEADERSHIP_ROLES.has(role)) throw workMemoryError('INVALID_LEADERSHIP_ROLE', `Unsupported leadership role: ${role}`);
  return role;
}

function normalizeParticipantStatus(value) {
  const status = String(value || 'active').trim().toLowerCase();
  if (!['active', 'removed'].includes(status)) throw workMemoryError('INVALID_PARTICIPANT_STATUS', `Unsupported participant status: ${status}`);
  return status;
}

function normalizeWorkVisibility(value) {
  const visibility = String(value || '').trim().toLowerCase();
  if (!WORK_VISIBILITIES.has(visibility)) throw workMemoryError('INVALID_WORK_VISIBILITY', `Unsupported work Memory visibility: ${visibility}`);
  return visibility;
}

function normalizeStoredVisibility(value) {
  const visibility = String(value || 'agent_private').trim().toLowerCase();
  if (visibility === 'private') return 'agent_private';
  return normalizeWorkVisibility(visibility);
}

function normalizeAgentIds(values, selfId = '') {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter((value) => value && value !== selfId))].sort();
}

function sanitizeMilestoneSummary(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

function normalizeMilestoneStatus(value) {
  const status = String(value || 'update').trim().toLowerCase();
  return new Set(['started', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled', 'update']).has(status)
    ? status
    : 'update';
}

function milestoneVisibility(status) {
  return ['blocked', 'failed'].includes(status) ? 'work_leadership' : 'work_participants';
}

function getOutboxByVersion(db, memoryDocumentVersionId) {
  if (!memoryDocumentVersionId) return null;
  return normalizePublicationOutbox(get(db, `SELECT * FROM work_memory_publication_outbox
    WHERE memory_document_version_id=?`, [memoryDocumentVersionId]));
}

function terminalTaskStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(String(status || '').toLowerCase());
}

function resolveTaskFederation(task, explicit = {}) {
  const direct = normalizeFederation(explicit.federationType, explicit.federationId);
  if (direct.id) return direct;
  const metadata = safeJsonParse(task?.metadata_json, {});
  const declared = normalizeFederation(metadata.workFederationType, metadata.workFederationId);
  if (declared.id) return declared;
  const delegationId = String(metadata.delegationId || metadata.agentDelegationId || '').trim();
  if (delegationId) return { type: 'delegation', id: delegationId };
  const groupId = String(metadata.collaborationGroupId || metadata.groupId || '').trim();
  if (groupId) return { type: 'collaboration_group', id: groupId };
  const parent = String(explicit.parentWorkScopeId || '').trim();
  const match = /^(?:work:)?(delegation|collaboration_group):(.+)$/.exec(parent);
  return match ? { type: match[1], id: match[2] } : { type: '', id: '' };
}

function normalizeFederation(typeValue = '', idValue = '') {
  const type = String(typeValue || '').trim().toLowerCase();
  const id = String(idValue || '').trim();
  if (!type && !id) return { type: '', id: '' };
  if (!['delegation', 'collaboration_group'].includes(type) || !id) {
    throw workMemoryError('INVALID_WORK_FEDERATION', 'Work federation requires a delegation or collaboration-group type and an exact ID.');
  }
  return { type, id };
}

function workMemoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeWorkScope(row) {
  if (!row) return null;
  return {
    id: row.id,
    scopeType: row.scope_type,
    sourceId: row.source_id,
    parentWorkScopeId: row.parent_work_scope_id || '',
    revisionId: row.revision_id || '',
    ownerUserId: row.owner_user_id || '',
    federationType: row.federation_type || '',
    federationId: row.federation_id || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeWorkParticipant(row) {
  if (!row) return null;
  return {
    id: row.id,
    workScopeId: row.work_scope_id,
    userId: row.user_id || '',
    agentInstanceId: row.agent_instance_id,
    agentFamilyId: row.agent_family_id || '',
    role: row.role,
    collaboratorAgentInstanceIds: safeJsonParse(row.collaboration_edges_json, []),
    validFrom: row.valid_from,
    validUntil: row.valid_until || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeLeadershipAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    workScopeId: row.work_scope_id,
    agentInstanceId: row.agent_instance_id,
    role: row.role,
    leadershipLevelSnapshot: row.leadership_level_snapshot || '',
    assignmentMode: row.assignment_mode || 'normal',
    limitSnapshot: safeJsonParse(row.limit_snapshot_json, {}),
    permissionSnapshot: safeJsonParse(row.permission_snapshot_json, {}),
    appointedBy: row.appointed_by || '',
    validFrom: row.valid_from,
    validUntil: row.valid_until || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizePublishedVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    memoryDocumentId: row.memory_document_id,
    versionNo: Number(row.version_no || 0),
    contentHash: row.content_hash || '',
    visibility: normalizeStoredVisibility(row.visibility),
    publishedAt: row.published_at || '',
    publishedByAgentInstanceId: row.published_by_agent_instance_id || '',
    sourceCursor: row.source_cursor || '',
    createdAt: row.created_at,
  };
}

function normalizePublicationOutbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id || '',
    workScopeId: row.work_scope_id,
    memoryDocumentVersionId: row.memory_document_version_id,
    federationType: row.federation_type,
    federationId: row.federation_id,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || '',
    nextAttemptAt: row.next_attempt_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || '',
  };
}

function normalizeWorkMemoryAudit(row) {
  return {
    id: row.id,
    requesterUserId: row.requester_user_id || '',
    requesterAgentInstanceId: row.requester_agent_instance_id || '',
    targetUserId: row.target_user_id || '',
    targetAgentInstanceId: row.target_agent_instance_id || '',
    workScopeId: row.work_scope_id || '',
    memoryDocumentId: row.memory_document_id || '',
    memoryDocumentVersionId: row.memory_document_version_id || '',
    requestedReason: row.requested_reason || '',
    requesterRoleSnapshot: row.requester_role_snapshot || '',
    leadershipAssignmentSnapshot: safeJsonParse(row.leadership_assignment_snapshot_json, {}),
    result: row.result,
    resultCode: row.result_code,
    createdAt: row.created_at,
  };
}
