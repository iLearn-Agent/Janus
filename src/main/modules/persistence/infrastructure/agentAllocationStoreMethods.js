import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';

const ACTIVE_WORK_STATUSES = Object.freeze(['queued', 'running']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_NODE_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const DEFAULT_RESERVATION_LEASE_MS = 60_000;

export function installAgentAllocationStoreMethods(prototype) {
  Object.assign(prototype, {
    getAgentAvailability({ userId = '', agentInstanceId = '', workspaceId = '' } = {}) {
      if (!agentInstanceId) return null;
      const instance = get(this.db, `SELECT id,user_id,agent_family_id,employment_state,instance_kind,updated_at
        FROM user_agent_instances WHERE id=?`, [agentInstanceId]);
      if (!instance || (userId && instance.user_id !== userId)) return null;
      const resolvedWorkspaceId = workspaceId
        ? this.resolveAccountWorkspaceId?.({ userId: userId || instance.user_id, workspaceId }) || 'workspace_personal'
        : '';
      const workspaceClause = resolvedWorkspaceId ? ' AND account_workspace_id=?' : '';
      const workspaceParams = resolvedWorkspaceId ? [resolvedWorkspaceId] : [];
      const reservation = normalizeReservation(get(this.db, `SELECT * FROM agent_work_reservations
        WHERE agent_instance_id=? AND status='active'${workspaceClause}
        ORDER BY reserved_at ASC LIMIT 1`, [agentInstanceId, ...workspaceParams]));
      const work = normalizeQueueWork(get(this.db, `SELECT * FROM agent_work_queue
        WHERE agent_instance_id=? AND status IN ('running','queued')${workspaceClause}
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,sequence_no ASC LIMIT 1`, [agentInstanceId, ...workspaceParams]));
      const latestWork = normalizeQueueWork(get(this.db, `SELECT * FROM agent_work_queue
        WHERE agent_instance_id=?${workspaceClause} ORDER BY updated_at DESC,sequence_no DESC LIMIT 1`, [agentInstanceId, ...workspaceParams]));
      const latestReservation = normalizeReservation(get(this.db, `SELECT * FROM agent_work_reservations
        WHERE agent_instance_id=?${workspaceClause} ORDER BY updated_at DESC,id DESC LIMIT 1`, [agentInstanceId, ...workspaceParams]));
      const blockedNode = get(this.db, `SELECT node.id,node.task_run_id,node.title,node.status,node.wait_reason,node.updated_at
        FROM task_nodes node JOIN task_runs task ON task.id=node.task_run_id
        WHERE node.agent_instance_id=? AND node.status IN ('blocked','waiting','retry_wait')
          AND task.status NOT IN ('completed','failed','cancelled')
          ${resolvedWorkspaceId ? 'AND task.account_workspace_id=?' : ''}
        ORDER BY node.updated_at DESC,node.id ASC LIMIT 1`, [agentInstanceId, ...workspaceParams]);
      const workState = work?.status === 'running' ? 'running'
        : blockedNode ? 'blocked'
          : work?.status === 'queued' ? 'queued'
            : reservation ? 'reserved' : '';
      const blockedWork = blockedNode ? {
        id: blockedNode.id,
        taskRunId: blockedNode.task_run_id,
        status: 'blocked',
        title: blockedNode.title || '',
        summary: blockedNode.wait_reason || '',
        updatedAt: blockedNode.updated_at || '',
      } : null;
      const currentWork = work?.status === 'running' ? work : blockedWork || work;
      return {
        agentInstanceId,
        agentFamilyId: instance.agent_family_id || '',
        availability: workState ? 'working' : 'idle',
        workState,
        reservation,
        currentWork,
        accountWorkspaceId: resolvedWorkspaceId || currentWork?.accountWorkspaceId || reservation?.accountWorkspaceId || '',
        updatedAt: latestStatusTimestamp(
          currentWork?.updatedAt,
          reservation?.updatedAt,
          latestWork?.updatedAt,
          latestReservation?.updatedAt,
          instance.updated_at,
        ),
      };
    },

    availabilitySnapshot(agentInstanceId, options = {}) {
      return this.getAgentAvailability({ userId: options.userId || '', agentInstanceId, workspaceId: options.workspaceId || '' });
    },

    listAgentAvailability({ userId = '', workspaceId = '' } = {}) {
      if (!userId) return [];
      return all(this.db, `SELECT id FROM user_agent_instances
        WHERE user_id=? AND instance_kind='employee' AND employment_state='active'
        ORDER BY created_at ASC,id ASC`, [userId])
        .map((row) => this.getAgentAvailability({ userId, agentInstanceId: row.id, workspaceId })).filter(Boolean);
    },

    createUBuddyAgentWaitRequests({ taskRunId = '', slots = [], reason = 'No matching employee is idle.' } = {}) {
      const task = get(this.db, 'SELECT * FROM task_runs WHERE id=?', [taskRunId]);
      if (!task) throw allocationError('ubuddy_allocation_task_missing', `Task run not found: ${taskRunId}`);
      const normalizedSlots = normalizeSlots(slots);
      if (!normalizedSlots.length) throw allocationError('ubuddy_allocation_slots_missing', 'uBuddy allocation requires at least one Agent slot.');
      return withImmediateTransaction(this, () => {
        const existing = this.listUBuddyAgentWaitRequests({ taskRunId });
        if (existing.length) return existing;
        const now = nowIso();
        for (const slot of normalizedSlots) {
          run(this.db, `INSERT INTO ubuddy_agent_wait_requests(
            id,account_workspace_id,owner_user_id,task_run_id,allocation_key,agent_family_id,department_id,
            preferred_agent_instance_id,candidate_instance_ids_json,task_node_ids_json,requirements_json,binding_policy,leader_slot,
            priority,status,wait_reason,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'waiting',?,?,?)`, [
            newId('ubuddy_wait'), task.account_workspace_id || 'workspace_personal', task.owner_user_id || '', taskRunId,
            slot.allocationKey, slot.agentFamilyId, slot.departmentId, slot.preferredAgentInstanceId,
            JSON.stringify(slot.candidateInstanceIds), JSON.stringify(slot.taskNodeIds), JSON.stringify(slot.requirements),
            slot.bindingPolicy, slot.leaderSlot ? 1 : 0, slot.priority, String(reason || ''), now, now,
          ]);
        }
        run(this.db, `UPDATE task_runs SET status='waiting',summary=?,updated_at=? WHERE id=?`, [String(reason || ''), now, taskRunId]);
        this.recordTaskEvent?.({
          taskRunId, eventType: 'ubuddy_agents_waiting', actorId: 'secretary_agent',
          summary: String(reason || 'uBuddy is waiting for eligible employees to become idle.'),
          payload: { slotCount: normalizedSlots.length, state: 'waiting_for_agents' },
        });
        return this.listUBuddyAgentWaitRequests({ taskRunId });
      });
    },

    listUBuddyAgentWaitRequests({ taskRunId = '', statuses = [], limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (taskRunId) { where.push('task_run_id=?'); params.push(taskRunId); }
      const cleanStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).filter((status) => ['waiting', 'matched', 'cancelled'].includes(status)))];
      if (cleanStatuses.length) {
        where.push(`status IN (${cleanStatuses.map(() => '?').join(',')})`);
        params.push(...cleanStatuses);
      }
      params.push(Math.max(1, Math.min(1000, Number(limit || 200))));
      return all(this.db, `SELECT * FROM ubuddy_agent_wait_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY priority ASC,created_at ASC,task_run_id ASC,id ASC LIMIT ?`, params).map(normalizeWaitRequest);
    },

    listWaitingCapabilityRequests(options = {}) {
      return this.listUBuddyAgentWaitRequests({ ...options, statuses: ['waiting'] });
    },

    listAgentWorkReservations({ taskRunId = '', agentInstanceId = '', statuses = [], limit = 200 } = {}) {
      const where = [];
      const params = [];
      if (taskRunId) { where.push('task_run_id=?'); params.push(taskRunId); }
      if (agentInstanceId) { where.push('agent_instance_id=?'); params.push(agentInstanceId); }
      const cleanStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).filter((status) => ['active', 'released', 'cancelled'].includes(status)))];
      if (cleanStatuses.length) {
        where.push(`status IN (${cleanStatuses.map(() => '?').join(',')})`);
        params.push(...cleanStatuses);
      }
      params.push(Math.max(1, Math.min(1000, Number(limit || 200))));
      return all(this.db, `SELECT * FROM agent_work_reservations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY reserved_at ASC,id ASC LIMIT ?`, params).map(normalizeReservation);
    },

    diagnoseTaskAgentAssignments({ taskRunId = '' } = {}) {
      const cleanTaskRunId = String(taskRunId || '').trim();
      if (!cleanTaskRunId) {
        return {
          valid: false,
          taskRunId: '',
          assignmentCount: 0,
          uniqueAgentInstanceCount: 0,
          duplicates: [],
          diagnostics: [{ code: 'task_agent_assignment_scope_missing', message: 'Task Agent assignment diagnostics require a task run id.' }],
        };
      }
      const task = get(this.db, 'SELECT id,lead_agent_instance_id,metadata_json FROM task_runs WHERE id=?', [cleanTaskRunId]);
      if (!task) {
        return {
          valid: false,
          taskRunId: cleanTaskRunId,
          assignmentCount: 0,
          uniqueAgentInstanceCount: 0,
          duplicates: [],
          diagnostics: [{ code: 'task_agent_assignment_task_missing', message: `Task run not found: ${cleanTaskRunId}` }],
        };
      }
      const assignments = all(this.db, `SELECT id,task_run_id,agent_instance_id,status,reserved_at,updated_at
        FROM agent_work_reservations WHERE task_run_id=? ORDER BY agent_instance_id ASC,reserved_at ASC,id ASC`, [cleanTaskRunId]);
      const duplicates = all(this.db, `SELECT task_run_id,agent_instance_id,COUNT(*) assignment_count
        FROM agent_work_reservations WHERE task_run_id=?
        GROUP BY task_run_id,agent_instance_id HAVING COUNT(*)>1
        ORDER BY agent_instance_id ASC`, [cleanTaskRunId]).map((row) => ({
        taskRunId: row.task_run_id,
        agentInstanceId: row.agent_instance_id,
        assignmentCount: Number(row.assignment_count || 0),
      }));
      const metadata = safeJsonParse(task.metadata_json, {});
      const participantAgentInstanceIds = (Array.isArray(metadata.participantAgentInstanceIds)
        ? metadata.participantAgentInstanceIds : [])
        .map((item) => String(item || '').trim()).filter(Boolean);
      const participantCounts = new Map();
      for (const agentInstanceId of participantAgentInstanceIds) {
        participantCounts.set(agentInstanceId, Number(participantCounts.get(agentInstanceId) || 0) + 1);
      }
      const duplicateParticipants = [...participantCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([agentInstanceId, assignmentCount]) => ({ taskRunId: cleanTaskRunId, agentInstanceId, assignmentCount }));
      const nodeInstanceIds = new Set(all(this.db, `SELECT DISTINCT agent_instance_id FROM task_nodes
        WHERE task_run_id=? AND agent_instance_id<>'' ORDER BY agent_instance_id ASC`, [cleanTaskRunId])
        .map((item) => String(item.agent_instance_id || '')).filter(Boolean));
      const activeReservationIds = new Set(assignments.filter((item) => item.status === 'active')
        .map((item) => String(item.agent_instance_id || '')).filter(Boolean));
      const expectedParticipantIds = new Set([...nodeInstanceIds, ...activeReservationIds,
        String(task.lead_agent_instance_id || '').trim()].filter(Boolean));
      const participantIdSet = new Set(participantAgentInstanceIds);
      const missingParticipants = [...expectedParticipantIds].filter((agentInstanceId) => !participantIdSet.has(agentInstanceId));
      const knownInstanceIds = participantAgentInstanceIds.length
        ? new Set(all(this.db, `SELECT id FROM user_agent_instances WHERE id IN (${participantAgentInstanceIds.map(() => '?').join(',')})`, participantAgentInstanceIds)
          .map((item) => String(item.id || '')))
        : new Set();
      const unknownParticipants = participantAgentInstanceIds.filter((agentInstanceId) => !knownInstanceIds.has(agentInstanceId));
      const diagnostics = [
        ...duplicates.map((item) => ({
          code: 'task_agent_assignment_duplicate',
          message: `Task ${item.taskRunId} has ${item.assignmentCount} assignment records for Agent instance ${item.agentInstanceId}.`,
          agentInstanceId: item.agentInstanceId,
          assignmentCount: item.assignmentCount,
        })),
        ...duplicateParticipants.map((item) => ({
          code: 'task_agent_participant_duplicate',
          message: `Task ${item.taskRunId} repeats Agent instance ${item.agentInstanceId} in participant metadata.`,
          agentInstanceId: item.agentInstanceId,
          assignmentCount: item.assignmentCount,
        })),
        ...missingParticipants.map((agentInstanceId) => ({
          code: 'task_agent_participant_missing',
          message: `Task ${cleanTaskRunId} references Agent instance ${agentInstanceId} in its leader, nodes, or active reservation but not in participant metadata.`,
          agentInstanceId,
        })),
        ...unknownParticipants.map((agentInstanceId) => ({
          code: 'task_agent_participant_unknown',
          message: `Task ${cleanTaskRunId} references unknown Agent instance ${agentInstanceId} in participant metadata.`,
          agentInstanceId,
        })),
      ];
      return {
        valid: diagnostics.length === 0,
        taskRunId: cleanTaskRunId,
        assignmentCount: assignments.length,
        uniqueAgentInstanceCount: new Set(assignments.map((item) => item.agent_instance_id).filter(Boolean)).size,
        duplicates,
        duplicateParticipants,
        missingParticipants,
        unknownParticipants,
        diagnostics,
      };
    },

    matchWaitingUBuddyAgentRequests({ taskRunId = '', limitTasks = 50 } = {}) {
      return withAgentReservationContentionFallback(this, taskRunId, () => {
        const params = [];
        const taskFilter = taskRunId ? 'AND request.task_run_id=?' : '';
        if (taskRunId) params.push(taskRunId);
        params.push(Math.max(1, Math.min(200, Number(limitTasks || 50))));
        const taskIds = all(this.db, `SELECT request.task_run_id,MIN(request.priority) task_priority,MIN(request.created_at) first_created
          FROM ubuddy_agent_wait_requests request JOIN task_runs task ON task.id=request.task_run_id
          WHERE request.status='waiting' ${taskFilter}
          GROUP BY request.task_run_id ORDER BY task_priority ASC,first_created ASC,request.task_run_id ASC LIMIT ?`, params);
        const matchedTasks = [];
        const waitingTasks = [];
        for (const item of taskIds) {
          const task = get(this.db, 'SELECT * FROM task_runs WHERE id=?', [item.task_run_id]);
          if (!task || TERMINAL_TASK_STATUSES.has(task.status)) {
            cancelWaitRequests(this, item.task_run_id, 'task_terminal');
            releaseReservations(this, { taskRunId: item.task_run_id, reason: 'task_terminal', status: 'cancelled' });
            continue;
          }
          const requests = this.listUBuddyAgentWaitRequests({ taskRunId: item.task_run_id, statuses: ['waiting'] });
          const selected = [];
          const selectedInstances = new Set();
          for (const request of requests) {
            const candidates = candidateRows(this, request);
            const candidate = candidates.find((row) => !selectedInstances.has(row.id) && agentIsIdle(this, row.id));
            if (!candidate) break;
            selected.push({ request, candidate });
            selectedInstances.add(candidate.id);
          }
          if (selected.length !== requests.length) {
            waitingTasks.push(item.task_run_id);
            continue;
          }
          const now = nowIso();
          const leaseOwner = `task:${task.id}`;
          const leaseExpiresAt = leaseExpiryIso();
          const participantInstanceIds = [];
          let leaderAgentInstanceId = '';
          for (const { request, candidate } of selected) {
            const existing = get(this.db, `SELECT id FROM agent_work_reservations
              WHERE task_run_id=? AND agent_instance_id=?`, [task.id, candidate.id]);
            const reservationId = existing?.id || newId('agent_reservation');
            if (existing) {
              run(this.db, `UPDATE agent_work_reservations SET status='active',agent_family_id=?,metadata_json=?,lease_owner=?,lease_expires_at=?,heartbeat_at=?,reserved_at=?,updated_at=?,
                released_at='',release_reason='' WHERE id=?`, [
                request.agentFamilyId, JSON.stringify({ allocationKey: request.allocationKey }), leaseOwner, leaseExpiresAt,
                now, now, now, reservationId,
              ]);
            } else {
              run(this.db, `INSERT INTO agent_work_reservations(
                id,account_workspace_id,owner_user_id,task_run_id,agent_instance_id,agent_family_id,status,metadata_json,
                lease_owner,lease_expires_at,heartbeat_at,reserved_at,updated_at
              ) VALUES(?,?,?,?,?,?,'active',?,?,?,?,?,?)`, [
                reservationId, task.account_workspace_id || 'workspace_personal', task.owner_user_id || '', task.id,
                candidate.id, request.agentFamilyId, JSON.stringify({ allocationKey: request.allocationKey }),
                leaseOwner, leaseExpiresAt, now, now, now,
              ]);
            }
            run(this.db, `UPDATE ubuddy_agent_wait_requests SET status='matched',reservation_id=?,matched_agent_instance_id=?,
              matched_at=?,updated_at=?,wait_reason='' WHERE id=? AND status='waiting'`, [reservationId, candidate.id, now, now, request.id]);
            for (const nodeId of request.taskNodeIds) {
              run(this.db, `UPDATE task_nodes SET agent_instance_id=?,status=CASE
                WHEN json_array_length(dependencies_json)>0 THEN 'pending' ELSE 'ready' END,wait_reason='',updated_at=?
                WHERE id=? AND task_run_id=?`, [candidate.id, now, nodeId, task.id]);
              const node = get(this.db, 'SELECT title,dependencies_json FROM task_nodes WHERE id=?', [nodeId]);
              this.recordTaskEvent?.({
                taskRunId: task.id, taskNodeId: nodeId, eventType: 'task_assigned', actorId: request.agentFamilyId,
                summary: `${node?.title || 'Task node'} assigned after idle reservation.`,
                payload: { agentInstanceId: candidate.id, agentId: request.agentFamilyId,
                  dependencies: safeJsonParse(node?.dependencies_json, []), reservationId },
              });
            }
            this.ensureTaskMemoryDocument?.({
              agentInstanceId: candidate.id, taskRunId: task.id, taskTitle: task.title,
              cloudEvolutionAllowed: Boolean(safeJsonParse(task.metadata_json, {}).cloudEvolutionAllowed),
              workspaceId: task.account_workspace_id || 'workspace_personal',
            });
            participantInstanceIds.push(candidate.id);
            if (request.leaderSlot) leaderAgentInstanceId = candidate.id;
            this.recordTaskEvent?.({
              taskRunId: task.id, eventType: 'agent_availability_changed', actorId: request.agentFamilyId,
              summary: `${candidate.id} reserved for ${task.title}.`,
              payload: { agentInstanceId: candidate.id, agentFamilyId: request.agentFamilyId, availability: 'working', workState: 'reserved', reservationId },
            });
          }
          const metadata = safeJsonParse(task.metadata_json, {});
          const nextTaskLeaderSelection = metadata.taskLeaderSelection && typeof metadata.taskLeaderSelection === 'object'
            ? { ...metadata.taskLeaderSelection, agentInstanceId: leaderAgentInstanceId || metadata.taskLeaderSelection.agentInstanceId || '' }
            : metadata.taskLeaderSelection;
          run(this.db, `UPDATE task_runs SET lead_agent_instance_id=CASE WHEN ?<>'' THEN ? ELSE lead_agent_instance_id END,
            status='ready',summary='',metadata_json=?,updated_at=? WHERE id=?`, [
            leaderAgentInstanceId, leaderAgentInstanceId,
            JSON.stringify({ ...metadata, participantAgentInstanceIds: [...new Set(participantInstanceIds)],
              ...(nextTaskLeaderSelection ? { taskLeaderSelection: nextTaskLeaderSelection } : {}) }), now, task.id,
          ]);
          this.recordTaskEvent?.({
            taskRunId: task.id, eventType: 'ubuddy_agents_allocated', actorId: 'secretary_agent',
            summary: `All ${selected.length} required Agent slots were reserved atomically.`,
            payload: { reservations: selected.map(({ request, candidate }) => ({ allocationKey: request.allocationKey, agentInstanceId: candidate.id })) },
          });
          matchedTasks.push(task.id);
        }
        const assignmentDiagnostics = matchedTasks.map((matchedTaskRunId) => this.diagnoseTaskAgentAssignments({ taskRunId: matchedTaskRunId }));
        const invalidAssignment = assignmentDiagnostics.find((item) => !item.valid);
        if (invalidAssignment) {
          throw allocationError('ubuddy_allocation_assignment_inconsistent', invalidAssignment.diagnostics[0]?.message
            || `Inconsistent Agent assignment detected for task ${invalidAssignment.taskRunId}.`);
        }
        return { matchedTaskIds: matchedTasks, waitingTaskIds: waitingTasks, assignmentDiagnostics };
      });
    },

    matchWaitingRequests(agentInstanceId = '') {
      const availability = agentInstanceId ? this.getAgentAvailability({ agentInstanceId }) : null;
      if (agentInstanceId && availability?.availability !== 'idle') {
        return { matchedTaskIds: [], waitingTaskIds: [], assignmentDiagnostics: [] };
      }
      return this.matchWaitingUBuddyAgentRequests({ limitTasks: 200 });
    },

    reserveAvailableAgent(requirement = {}) {
      const taskRunId = String(requirement.taskRunId || '').trim();
      if (!taskRunId) throw allocationError('ubuddy_allocation_task_missing', 'taskRunId is required to reserve an Agent.');
      const task = this.getTaskRun?.(taskRunId);
      if (!task) throw allocationError('ubuddy_allocation_task_missing', `Task run not found: ${taskRunId}`);
      const slot = normalizeSlots([{ ...requirement, taskNodeIds: requirement.taskNodeIds || ['__reservation_only__'] }])[0];
      if (!slot) throw allocationError('ubuddy_allocation_slots_missing', 'A valid Agent requirement is required.');
      return withImmediateTransaction(this, () => {
        const candidate = candidateRows(this, { ...slot, ownerUserId: task.ownerUserId || task.owner_user_id || '' })
          .find((row) => agentIsIdle(this, row.id));
        if (!candidate) return null;
        const now = nowIso();
        const id = newId('agent_reservation');
        run(this.db, `INSERT INTO agent_work_reservations(
          id,account_workspace_id,owner_user_id,task_run_id,agent_instance_id,agent_family_id,status,metadata_json,
          lease_owner,lease_expires_at,heartbeat_at,reserved_at,updated_at
        ) VALUES(?,?,?,?,?,?,'active',?,?,?,?,?,?)`, [
          id, task.workspaceId || task.accountWorkspaceId || 'workspace_personal', task.ownerUserId || '', taskRunId,
          candidate.id, slot.agentFamilyId, JSON.stringify({ allocationKey: slot.allocationKey }),
          `task:${taskRunId}`, leaseExpiryIso(), now, now, now,
        ]);
        return this.listAgentWorkReservations({ taskRunId, agentInstanceId: candidate.id, statuses: ['active'] })[0] || null;
      });
    },

    releaseAgentReservation(reservationId = '', reason = 'reservation_released') {
      const reservation = normalizeReservation(get(this.db, 'SELECT * FROM agent_work_reservations WHERE id=?', [reservationId]));
      if (!reservation) return null;
      return this.releaseTaskAgentReservations({ taskRunId: reservation.taskRunId, agentInstanceId: reservation.agentInstanceId, reason })[0] || null;
    },

    releaseTaskAgentReservations({ taskRunId = '', agentInstanceId = '', reason = 'task_released', cancelled = false } = {}) {
      return withImmediateTransaction(this, () => releaseReservations(this, {
        taskRunId, agentInstanceId, reason, status: cancelled ? 'cancelled' : 'released',
      }));
    },

    releaseCompletedTaskAgentReservations({ taskRunId = '', reason = 'assigned_work_completed' } = {}) {
      const task = this.getTaskRun?.(taskRunId);
      if (!task) return [];
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        return this.releaseTaskAgentReservations({ taskRunId, reason: `task_${task.status}`, cancelled: task.status === 'cancelled' });
      }
      const released = [];
      for (const reservation of this.listAgentWorkReservations({ taskRunId, statuses: ['active'] })) {
        if (reservation.agentInstanceId === task.leadAgentInstanceId) continue;
        const assignedNodes = (task.nodes || []).filter((node) => node.agentInstanceId === reservation.agentInstanceId);
        if (!assignedNodes.length || assignedNodes.some((node) => !TERMINAL_NODE_STATUSES.has(node.status))) continue;
        released.push(...this.releaseTaskAgentReservations({ taskRunId, agentInstanceId: reservation.agentInstanceId, reason }));
      }
      return released;
    },

    recoverUBuddyAgentAllocations() {
      return withImmediateTransaction(this, () => {
        const now = nowIso();
        const terminalTaskIds = all(this.db, `SELECT DISTINCT task.id FROM task_runs task
          LEFT JOIN ubuddy_agent_wait_requests request ON request.task_run_id=task.id AND request.status='waiting'
          LEFT JOIN agent_work_reservations reservation ON reservation.task_run_id=task.id AND reservation.status='active'
          WHERE task.status IN ('completed','failed','cancelled') AND (request.id IS NOT NULL OR reservation.id IS NOT NULL)`);
        let cancelledWaitCount = 0;
        let releasedReservationCount = 0;
        for (const item of terminalTaskIds) {
          cancelledWaitCount += cancelWaitRequests(this, item.id, 'task_terminal');
          releasedReservationCount += releaseReservations(this, {
            taskRunId: item.id, reason: 'task_terminal_recovery', status: 'released',
          }).length;
        }
        const expiredTaskIds = all(this.db, `SELECT DISTINCT task_run_id FROM agent_work_reservations
          WHERE status='active' AND lease_expires_at<>'' AND lease_expires_at<=? ORDER BY task_run_id ASC`, [now]);
        let expiredReservationCount = 0;
        for (const item of expiredTaskIds) {
          const task = this.getTaskRun?.(item.task_run_id);
          if (!task || TERMINAL_TASK_STATUSES.has(task.status)) continue;
          const active = this.listAgentWorkReservations({ taskRunId: item.task_run_id, statuses: ['active'] });
          expiredReservationCount += active.length;
          for (const reservation of active) {
            run(this.db, `UPDATE agent_work_reservations SET status='released',release_reason='lease_expired',released_at=?,updated_at=?
              WHERE id=? AND status='active'`, [now, now, reservation.id]);
          }
          run(this.db, `UPDATE ubuddy_agent_wait_requests SET status='waiting',reservation_id='',matched_agent_instance_id='',
            matched_at='',wait_reason='Reservation lease expired; waiting for atomic reassignment.',updated_at=?
            WHERE task_run_id=? AND status='matched'`, [now, item.task_run_id]);
          run(this.db, `UPDATE task_nodes SET agent_instance_id='',status='waiting',
            wait_reason='Reservation lease expired; waiting for reassignment.',updated_at=?
            WHERE task_run_id=? AND status NOT IN ('completed','failed','cancelled','skipped')`, [now, item.task_run_id]);
          run(this.db, `UPDATE task_runs SET lead_agent_instance_id='',status='waiting',summary='Reservation lease expired; waiting for reassignment.',updated_at=?
            WHERE id=?`, [now, item.task_run_id]);
        }
        const healthy = all(this.db, `SELECT reservation.id FROM agent_work_reservations reservation
          JOIN task_runs task ON task.id=reservation.task_run_id
          WHERE reservation.status='active' AND task.status NOT IN ('completed','failed','cancelled')
            AND (reservation.lease_expires_at='' OR reservation.lease_expires_at>?)`, [now]);
        const nextExpiry = leaseExpiryIso();
        for (const reservation of healthy) {
          run(this.db, `UPDATE agent_work_reservations SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='active'`,
            [now, nextExpiry, now, reservation.id]);
        }
        const matched = this.matchWaitingUBuddyAgentRequests({ limitTasks: 200 });
        return { cancelledWaitCount, releasedReservationCount, expiredReservationCount, renewedReservationCount: healthy.length, ...matched };
      });
    },
  });
}

function candidateRows(store, request) {
  if (request.bindingPolicy === 'exact') {
    if (!request.preferredAgentInstanceId) return [];
    return all(store.db, `SELECT id,user_id,agent_family_id FROM user_agent_instances
      WHERE id=? AND user_id=? AND agent_family_id=? AND instance_kind='employee' AND employment_state='active'`, [
      request.preferredAgentInstanceId, request.ownerUserId, request.agentFamilyId,
    ]);
  }
  const preferredOrder = [...new Set([
    request.preferredAgentInstanceId,
    ...request.candidateInstanceIds,
  ].filter(Boolean))];
  const rows = all(store.db, `SELECT id,user_id,agent_family_id FROM user_agent_instances
    WHERE user_id=? AND agent_family_id=? AND instance_kind='employee' AND employment_state='active'`, [
    request.ownerUserId, request.agentFamilyId,
  ]);
  return rows.sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.id);
    const rightIndex = preferredOrder.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      || left.id.localeCompare(right.id);
  });
}

function agentIsIdle(store, agentInstanceId) {
  const reservation = get(store.db, `SELECT 1 FROM agent_work_reservations
    WHERE agent_instance_id=? AND status='active' LIMIT 1`, [agentInstanceId]);
  if (reservation) return false;
  const work = get(store.db, `SELECT 1 FROM agent_work_queue
    WHERE agent_instance_id=? AND status IN ('queued','running') LIMIT 1`, [agentInstanceId]);
  return !work;
}

function releaseReservations(store, { taskRunId, agentInstanceId = '', reason, status }) {
  if (!taskRunId) return [];
  const reservations = store.listAgentWorkReservations({ taskRunId, agentInstanceId, statuses: ['active'] });
  const now = nowIso();
  for (const reservation of reservations) {
    run(store.db, `UPDATE agent_work_reservations SET status=?,release_reason=?,released_at=?,updated_at=?
      WHERE id=? AND status='active'`, [status, String(reason || ''), now, now, reservation.id]);
    const availability = store.getAgentAvailability?.({ userId: reservation.ownerUserId, agentInstanceId: reservation.agentInstanceId })
      || { availability: 'idle', workState: '' };
    store.recordTaskEvent?.({
      taskRunId, eventType: 'agent_availability_changed', actorId: reservation.agentFamilyId,
      summary: `${reservation.agentInstanceId} released from ${taskRunId}.`,
      payload: { agentInstanceId: reservation.agentInstanceId, agentFamilyId: reservation.agentFamilyId,
        availability: availability.availability, workState: availability.workState, reservationId: reservation.id, reason },
    });
  }
  return reservations.map((reservation) => ({ ...reservation, status, releaseReason: String(reason || ''), releasedAt: now, updatedAt: now }));
}

function cancelWaitRequests(store, taskRunId, reason) {
  const now = nowIso();
  const result = run(store.db, `UPDATE ubuddy_agent_wait_requests SET status='cancelled',wait_reason=?,cancelled_at=?,updated_at=?
    WHERE task_run_id=? AND status='waiting'`, [String(reason || ''), now, now, taskRunId]);
  return Number(result?.changes || 0);
}

function normalizeSlots(slots) {
  const seen = new Set();
  return (Array.isArray(slots) ? slots : []).map((slot, index) => {
    const agentFamilyId = String(slot?.agentFamilyId || slot?.agentId || '').trim();
    const allocationKey = String(slot?.allocationKey || `${agentFamilyId}:${slot?.preferredAgentInstanceId || index + 1}`).trim();
    if (!agentFamilyId || !allocationKey || seen.has(allocationKey)) return null;
    seen.add(allocationKey);
    return {
      allocationKey,
      agentFamilyId,
      departmentId: String(slot?.departmentId || ''),
      preferredAgentInstanceId: String(slot?.preferredAgentInstanceId || ''),
      candidateInstanceIds: [...new Set((Array.isArray(slot?.candidateInstanceIds) ? slot.candidateInstanceIds : []).map(String).filter(Boolean))],
      taskNodeIds: [...new Set((Array.isArray(slot?.taskNodeIds) ? slot.taskNodeIds : []).map(String).filter(Boolean))],
      requirements: slot?.requirements && typeof slot.requirements === 'object' ? slot.requirements : {},
      bindingPolicy: slot?.bindingPolicy === 'exact' ? 'exact' : 'family',
      leaderSlot: Boolean(slot?.leaderSlot),
      priority: Math.max(1, Math.min(100, Number(slot?.priority || 50))),
    };
  }).filter((slot) => slot && slot.taskNodeIds.length);
}

function normalizeReservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    taskRunId: row.task_run_id,
    agentInstanceId: row.agent_instance_id,
    agentFamilyId: row.agent_family_id || '',
    status: row.status,
    metadata: safeJsonParse(row.metadata_json, {}),
    leaseOwner: row.lease_owner || '',
    leaseExpiresAt: row.lease_expires_at || '',
    heartbeatAt: row.heartbeat_at || '',
    reservedAt: row.reserved_at || '',
    updatedAt: row.updated_at || '',
    releasedAt: row.released_at || '',
    releaseReason: row.release_reason || '',
  };
}

function normalizeWaitRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    taskRunId: row.task_run_id,
    allocationKey: row.allocation_key,
    agentFamilyId: row.agent_family_id,
    departmentId: row.department_id || '',
    preferredAgentInstanceId: row.preferred_agent_instance_id || '',
    candidateInstanceIds: safeJsonParse(row.candidate_instance_ids_json, []),
    taskNodeIds: safeJsonParse(row.task_node_ids_json, []),
    requirements: safeJsonParse(row.requirements_json, {}),
    bindingPolicy: row.binding_policy === 'exact' ? 'exact' : 'family',
    leaderSlot: Boolean(row.leader_slot),
    priority: Number(row.priority || 50),
    status: row.status,
    reservationId: row.reservation_id || '',
    matchedAgentInstanceId: row.matched_agent_instance_id || '',
    waitReason: row.wait_reason || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    matchedAt: row.matched_at || '',
    cancelledAt: row.cancelled_at || '',
  };
}

function normalizeQueueWork(row) {
  if (!row) return null;
  return {
    id: row.id,
    workKind: row.work_kind,
    workId: row.work_id,
    status: row.status,
    payload: safeJsonParse(row.payload_json, {}),
    enqueuedAt: row.enqueued_at || '',
    startedAt: row.started_at || '',
    updatedAt: row.updated_at || '',
  };
}

function latestStatusTimestamp(...values) {
  return values.map((value) => String(value || '').trim()).filter(Boolean).sort().at(-1) || '';
}

function withImmediateTransaction(store, operation) {
  const ownsTransaction = !store.db.isTransaction;
  if (ownsTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (ownsTransaction) store.db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
}

function allocationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAgentReservationContention(error) {
  const detail = String(error?.message || error || '');
  return /UNIQUE constraint failed:\s*agent_work_reservations\.agent_instance_id/i.test(detail)
    || /idx_agent_work_reservations_one_active/i.test(detail);
}

function withAgentReservationContentionFallback(store, taskRunId, operation) {
  const ownsTransaction = !store.db.isTransaction;
  try {
    return withImmediateTransaction(store, operation);
  } catch (error) {
    if (!ownsTransaction || !isAgentReservationContention(error)) throw error;
    const waitingTaskIds = [...new Set(store.listUBuddyAgentWaitRequests({
      taskRunId, statuses: ['waiting'], limit: 1000,
    }).map((request) => request.taskRunId))];
    return { matchedTaskIds: [], waitingTaskIds, assignmentDiagnostics: [] };
  }
}

function leaseExpiryIso(baseMs = Date.now()) {
  const configured = Number(process.env.JANUS_AGENT_RESERVATION_LEASE_MS || DEFAULT_RESERVATION_LEASE_MS);
  const leaseMs = Number.isFinite(configured) ? Math.max(5_000, configured) : DEFAULT_RESERVATION_LEASE_MS;
  return new Date(baseMs + leaseMs).toISOString();
}

export { ACTIVE_WORK_STATUSES };
