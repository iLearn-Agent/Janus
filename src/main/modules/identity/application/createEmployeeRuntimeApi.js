import { EMPLOYEE_POLICY_VERSION, EMPLOYEE_QUOTA_LIMIT } from '../domain/employeePolicy.js';
import { LEGACY_PPT_AGENT_IDS, canonicalPptAgentId } from '../../../../shared/pptAgents.js';
import { canonicalGeneralAgentId } from '../../../../shared/generalAgents.js';
import { sanitizePublicWorkStatusText } from '../../../../shared/contracts/uBuddyWorkStatus.js';

const LEGACY_PPT_AGENT_ID_SET = new Set(LEGACY_PPT_AGENT_IDS);
const canonicalEmployeeAgentFamilyId = (value = '') => canonicalGeneralAgentId(canonicalPptAgentId(value));

export function createEmployeeRuntimeApi({
  auth, store, cloudSync = null, evolutionCoordinators = null, triggerAutoSync = null,
  hasActiveAgentChatRun = () => false,
} = {}) {
  if (!auth || !store) throw new Error('Employee runtime API requires auth and Store.');
  const employeeCommandInFlight = new Map();
  const employeeLifecycleRequestInFlight = new Map();

  const currentUser = () => auth.requireUser();
  const assertOwnedInstance = (userId, agentInstanceId) => {
    const instance = store.resolveUserAgent({ agentInstanceId: String(agentInstanceId || '') })?.instance || null;
    if (!instance) throw employeeError('agent_instance_not_found', 'Employee Agent instance was not found.');
    if (instance.userId !== userId) throw employeeError('agent_instance_owner_mismatch', 'Employee Agent instance does not belong to the user.');
    return instance;
  };
  const refreshSync = (reason) => triggerAutoSync?.(reason, { delayMs: 0 });
  const currentDeviceId = () => cloudSync?.status?.().deviceId || cloudSync?.status?.().device_id || 'local';
  const assertMemoryContextIdle = (instance) => {
    const workspaceId = store.activeAccountWorkspace?.({ userId: instance.userId, deviceId: currentDeviceId() })?.id || 'workspace_personal';
    const primary = store.getPrimaryAgentSession?.({ userId: instance.userId, agentInstanceId: instance.id, workspaceId });
    if (!hasActiveAgentChatRun({
      userId: instance.userId,
      workspaceId,
      agentInstanceId: instance.id,
      primarySessionId: primary?.id || '',
    })) return;
    throw employeeError('memory_switch_during_active_chat', '当前 Agent 正在回答，请等待本轮结束后再切换 Memory。');
  };
  const assertWorkspaceDocument = (userId, document) => {
    const active = store.activeAccountWorkspace?.({ userId, deviceId: currentDeviceId() });
    if (!document || document.workspaceId !== (active?.id || 'workspace_personal')) {
      throw employeeError('memory_document_workspace_mismatch', 'Memory document does not belong to the active Workspace.');
    }
    return document;
  };
  const memoryApplicationState = (instance, { threadReset = false } = {}) => {
    const context = store.getDeviceContextState({
      deviceId: currentDeviceId(), userId: instance.userId, agentInstanceId: instance.id,
    });
    const resolution = store.resolveMemoryContext?.({
      agentInstanceId: instance.id,
      contextSpaceId: context?.activeContextSpaceId || '',
      purpose: 'runtime',
      deviceId: currentDeviceId(),
    });
    return {
      activeMemoryDocumentId: context?.activeMemoryDocumentId || '',
      activeContextSpaceId: context?.activeContextSpaceId || '',
      primarySessionId: context?.primarySessionId || '',
      memoryManifestHash: resolution?.manifestHash || '',
      threadReset: Boolean(threadReset),
      applicationState: resolution?.manifestHash ? 'applied' : 'selected_pending_runtime_context',
    };
  };

  const conversationOverview = (agentInstanceId = '') => {
    const user = currentUser();
    const requestedAgentInstanceId = String(agentInstanceId || '').trim();
    const instance = assertOwnedInstance(user.id, requestedAgentInstanceId);
    const resolvedAgentInstanceId = String(instance.id || '').trim();
    const deviceId = currentDeviceId();
    const workspaceId = store.activeAccountWorkspace?.({ userId: user.id, deviceId })?.id || 'workspace_personal';
    const primarySession = store.getPrimaryAgentSession?.({ userId: user.id, agentInstanceId: instance.id, workspaceId }) || null;
    const contextState = store.getDeviceContextState?.({
      deviceId, userId: user.id, agentInstanceId: instance.id, workspaceId,
    }) || null;
    const primarySessionAgentInstanceId = String(primarySession?.agentInstanceId || primarySession?.agent_instance_id || '').trim();
    if (primarySession && primarySessionAgentInstanceId !== resolvedAgentInstanceId) {
      throw employeeError('agent_session_identity_mismatch', 'Employee conversation identity no longer matches the selected Agent.');
    }
    if (primarySession) store.recordAgentConversationBranch?.({ session: primarySession });
    const branches = store.listAgentConversationBranches?.({ userId: user.id, agentInstanceId: instance.id }) || [];
    const timeline = store.listAgentConversationTimeline?.({
      userId: user.id,
      agentInstanceId: instance.id,
      memoryDocumentId: contextState?.activeMemoryDocumentId || '',
      contextSpaceId: contextState?.activeContextSpaceId || '',
      limit: 200,
    })
      || { windowId: `agent:${instance.id}`, items: [], nextCursor: null };
    const availability = store.getAgentAvailability?.({ userId: user.id, agentInstanceId: instance.id, workspaceId }) || null;
    const activeQueue = store.listAgentWorkQueue?.({
      userId: user.id,
      agentInstanceId: instance.id,
      workspaceId,
      statuses: ['queued', 'running'],
      limit: 200,
    }) || [];
    const currentWork = activeQueue.find((work) => work.status === 'running')
      || activeQueue.find((work) => work.status === 'queued')
      || null;
    const taskWork = activeQueue.find((work) => work.workKind === 'task_node' && work.status === 'running')
      || activeQueue.find((work) => work.workKind === 'task_node' && work.status === 'queued')
      || null;
    const sessionId = !taskWork && currentWork?.workKind === 'chat'
      ? String(currentWork.payload?.sessionId || '')
      : '';
    const reservedTaskRunId = String(availability?.reservation?.taskRunId || '');
    const reservedTaskCandidate = reservedTaskRunId ? store.getTaskRun?.(reservedTaskRunId) || null : null;
    const reservedTask = reservedTaskCandidate?.workspaceId === workspaceId ? reservedTaskCandidate : null;
    const taskRunId = String(taskWork?.taskRunId || taskWork?.payload?.taskRunId
      || reservedTask?.id || (!sessionId ? currentWork?.taskRunId || currentWork?.payload?.taskRunId : '') || '');
    const task = taskRunId ? store.getTaskRun?.(taskRunId) || null : null;
    const relatedNodes = (Array.isArray(task?.nodes) ? task.nodes : []).filter((node) => (
      String(node.agentInstanceId || node.agent_instance_id || '').trim() === instance.id
    ));
    const relatedNodeIds = new Set(relatedNodes.map((node) => String(node.id || '')).filter(Boolean));
    const relatedEvents = (Array.isArray(task?.events) ? task.events : []).filter((event) => (
      employeeTaskEventVisible(event)
      && (relatedNodeIds.has(String(event.taskNodeId || event.task_node_id || ''))
        || String(event.payload?.agentInstanceId || event.payload?.agent_instance_id || '').trim() === instance.id)
    ));
    const recentWorkEvents = sortEmployeeTaskEvents(relatedEvents).slice(-5).map((event) => ({
      id: String(event.id || event.eventId || ''),
      type: String(event.eventType || event.event_type || ''),
      summary: employeeVisibleTaskText(event.summary),
      status: String(event.status || event.payload?.status || ''),
      createdAt: event.updatedAt || event.updated_at || event.createdAt || event.created_at || '',
    }));
    const latestProgressEvent = latestEmployeeTaskEvent(relatedEvents.filter((event) => (
      ['node_activity', 'node_progress'].includes(String(event.eventType || event.event_type || ''))
      && String(event.summary || '').trim()
    ))) || latestEmployeeTaskEvent(relatedEvents.filter((event) => String(event.summary || '').trim()));
    const activeNode = relatedNodes.find((node) => String(node.id || '') === String(taskWork?.workId || ''))
      || selectEmployeeActiveTaskNode(relatedNodes);
    const blockedNode = relatedNodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(String(node.status || ''))) || null;
    const completedNodeCount = relatedNodes.filter((node) => String(node.status || '') === 'completed').length;
    const workSessionCandidate = sessionId ? store.getSession?.(sessionId) || null : null;
    const workSession = workSessionCandidate
      && workSessionCandidate.userId === user.id
      && workSessionCandidate.workspaceId === workspaceId
      && workSessionCandidate.agentInstanceId === instance.id
      ? workSessionCandidate
      : null;
    const activeWorkSource = taskWork || currentWork;
    const activeWork = activeWorkSource || task ? {
      ...(activeWorkSource || {}),
      title: task?.title || activeWorkSource?.title || primarySession?.title || '正在处理工作',
      summary: task?.summary || activeWorkSource?.summary || '',
      sessionId: workSession?.id || '',
      session: workSession,
      taskRunId,
      startedAt: activeWorkSource?.startedAt || activeWorkSource?.enqueuedAt || task?.startedAt || task?.createdAt || '',
      route: workSession ? 'session' : taskRunId ? 'task_run' : 'none',
      status: String(task?.status || taskWork?.status || activeWorkSource?.status || availability?.workState || ''),
      currentAction: employeeVisibleTaskText(latestProgressEvent?.summary || activeNode?.title || activeWorkSource?.title || activeWorkSource?.summary || ''),
      currentStage: ['verifying', 'delivering'].includes(String(task?.status || ''))
        ? String(task.status) : taskWork?.status === 'queued' ? 'queued' : blockedNode ? 'blocked' : 'executing',
      progress: {
        completed: completedNodeCount,
        total: relatedNodes.length,
        percent: relatedNodes.length ? Math.round((completedNodeCount / relatedNodes.length) * 100) : null,
      },
      nodes: relatedNodes.slice(0, 12).map((node) => ({
        id: String(node.id || ''),
        title: String(node.title || '任务节点').slice(0, 240),
        status: String(node.status || 'pending'),
      })),
      recentEvents: recentWorkEvents,
      blocker: blockedNode ? {
        summary: employeeVisibleTaskText(blockedNode.waitReason || blockedNode.errorText || `${blockedNode.title || '任务节点'}暂时受阻。`),
        status: String(blockedNode.status || ''),
      } : null,
      updatedAt: latestProgressEvent?.updatedAt || latestProgressEvent?.createdAt
        || availability?.updatedAt || activeNode?.updatedAt || task?.updatedAt || '',
    } : { route: 'none', sessionId: '', taskRunId: '' };
    const queuedTaskRunIds = [...new Set(activeQueue.map((work) => String(
      work.taskRunId || work.payload?.taskRunId || '',
    ).trim()).filter((id) => id && id !== taskRunId))];
    return {
      requestedAgentInstanceId,
      resolvedAgentInstanceId,
      identityChanged: Boolean(requestedAgentInstanceId && requestedAgentInstanceId !== resolvedAgentInstanceId),
      windowId: timeline.windowId || `agent:${resolvedAgentInstanceId}`,
      primarySession,
      activeBranch: branches.find((branch) => branch.workspaceId === workspaceId) || null,
      branches,
      timeline,
      currentMemoryScoped: true,
      historySessions: [],
      historyGroups: [],
      activeWork,
      taskQueue: { count: queuedTaskRunIds.length, taskRunIds: queuedTaskRunIds },
      workspaceId,
    };
  };

  async function employeeOverview({ includeEvents = true, refreshCloud = true } = {}) {
    const user = currentUser();
    let cloudOverview = null;
    let cloudOverviewError = '';
    if (refreshCloud) {
      try {
        if (typeof cloudSync?.syncEmployeeAuthority === 'function') {
          const employeeSync = await cloudSync.syncEmployeeAuthority();
          cloudOverview = employeeSync?.overview || await cloudSync?.employeeOverview?.();
          await cloudSync?.refreshEmployeeProgressionProjections?.().catch(() => null);
        } else {
          cloudOverview = await cloudSync?.employeeOverview?.();
        }
      } catch (error) {
        cloudOverviewError = employeeSyncErrorCode(error);
      }
    }
    const recruitment = employeeCloudMutationReadiness(user, cloudSync?.status?.() || {}, cloudOverviewError);
    if (!recruitment.enabled) {
      store.blockEmployeeCommandsForCloudAuth?.({
        userId: user.id,
        error: `${recruitment.code}: ${recruitment.message}`,
      });
    }
    const baseQuota = store.getEmployeeQuota({ userId: user.id, limit: EMPLOYEE_QUOTA_LIMIT });
    const systemRoster = store.ensureSystemAgentInstances({ userId: user.id })
      .filter((instance) => instance.agentFamilyId === 'secretary_agent')
      .map((instance) => employeeRosterItem(store, {
        ...instance,
        routeEligible: instance.status === 'active' && instance.employmentState === 'active',
        defaultRecruited: true,
      }, cloudSync));
    const employeeRoster = store.listEmployeeRoster({ userId: user.id, includeInactive: true })
      .filter((instance) => !LEGACY_PPT_AGENT_ID_SET.has(instance.agentFamilyId))
      .map((instance) => employeeRosterItem(store, instance, cloudSync));
    const roster = [...systemRoster, ...employeeRoster];
    const reserved = roster.filter((item) => item.employmentState !== 'active'
      && item.employmentState !== 'conflict'
      && item.authorityState === 'pending'
      && item.pendingTargetState === 'active').length;
    const active = roster.filter((item) => item.employmentState === 'active' && !item.quotaExempt).length;
    const used = active + reserved;
    const authority = 'cloud';
    const cloudMemory = cloudSync?.status?.().multiMemory || { enabled: false, readOnly: true, code: 'cloud_not_configured' };
    const multiMemory = {
      ...cloudMemory,
      enabled: true,
      readOnly: false,
      authority: 'local_first',
      cloudReady: Boolean(cloudMemory.enabled && !cloudMemory.readOnly),
      syncState: cloudMemory.enabled && !cloudMemory.readOnly ? 'ready' : 'pending_cloud_sync',
    };
    return {
      authority,
      policyVersion: cloudOverview?.policyVersion || EMPLOYEE_POLICY_VERSION,
      quota: {
        ...baseQuota,
        ...(cloudOverview?.quota || {}),
        active,
        reserved,
        used,
        remaining: Math.max(0, Number(cloudOverview?.quota?.limit || baseQuota.limit) - used),
        grandfatheredOverLimit: used > Number(cloudOverview?.quota?.limit || baseQuota.limit),
        policyState: used > Number(cloudOverview?.quota?.limit || baseQuota.limit) ? 'grandfathered_over_limit' : 'within_limit',
      },
      roster,
      recruitableFamilies: mergeRecruitableFamilies(
        store.listRecruitableAgentFamilies({ userId: user.id }),
        cloudOverview ? cloudOverview.recruitableFamilies || [] : null,
      ),
      recruitmentEvents: includeEvents ? store.listRecruitmentEvents({ userId: user.id, limit: 100 }) : [],
      leadershipGovernance: user.role === 'admin' ? {
        actions: cloudSync?.stage8Projection?.('leadership:governance_actions')?.payload || [],
        appeals: cloudSync?.stage8Projection?.('leadership:governance_appeals')?.payload || [],
      } : null,
      capabilities: {
        recruitment: { ...recruitment, authority },
        performance: evolutionCoordinators?.cluster?.status?.().performance || { enabled: false, code: 'performance_pending_cloud' },
        leadership: cloudSync?.cachedEvolutionCapabilities?.().leadership
          || { authority: 'cloud', enabled: false, code: cloudSync?.status?.().configured ? 'leadership_contract_unsupported' : 'cloud_not_configured' },
        market: evolutionCoordinators?.cluster?.status?.().market || { enabled: false, code: 'market_pending_cloud' },
        multiMemory,
      },
      lastSyncError: cloudOverviewError,
    };
  }

  async function executeCloudCommand({ action, user, agentFamilyId = '', agentInstanceId = '', commandId, expectedStateRevision, reason = 'user' }) {
    const readiness = employeeCloudMutationReadiness(user, cloudSync?.status?.() || {});
    if (!readiness.enabled) throw employeeError(readiness.code, readiness.message, readiness);
    const staged = store.stagePendingEmployeeCommand({
      userId: user.id,
      remoteUserId: cloudSync?.status?.().userId || cloudSync?.status?.().user_id || '',
      action,
      agentFamilyId: canonicalEmployeeAgentFamilyId(agentFamilyId),
      agentInstanceId,
      commandId,
      expectedStateRevision,
      sourceDeviceId: cloudSync?.status?.().deviceId || cloudSync?.status?.().device_id || '',
      reason,
    });
    if (action === 'deactivate') {
      store.cancelQueuedAgentWork?.({ agentInstanceId: staged.instance?.id || agentInstanceId, reason: 'employee_deactivation_pending' });
    }
    const localResult = employeeCommandResult(staged, await employeeOverview({ refreshCloud: false }));
    if (staged.idempotent) {
      refreshSync(`employee_${action}_already_pending`);
      return localResult;
    }
    const cloudStatus = cloudSync?.status?.() || {};
    if (!cloudStatus.configured || typeof cloudSync?.submitEmployeeCommand !== 'function') {
      store.markEmployeeCommandAttempt?.({
        commandId,
        status: cloudStatus.configured ? 'failed' : 'blocked_auth',
        error: cloudStatus.configured
          ? 'employee_cloud_unavailable: Cloud employee synchronization is unavailable.'
          : 'cloud_auth_required: Cloud account authentication is required for employee lifecycle synchronization.',
      });
      refreshSync(`employee_${action}_pending`);
      return employeeCommandResult(staged, await employeeOverview({ refreshCloud: false }));
    }
    if (staged.deferredByCommandId || staged.command?.dependsOnCommandId) {
      const dependencyId = staged.deferredByCommandId || staged.command?.dependsOnCommandId || '';
      Promise.resolve(employeeCommandInFlight.get(dependencyId)).catch(() => null).then(async () => {
        let syncResult = null;
        if (typeof cloudSync?.drainEmployeeCommandOutbox === 'function') {
          syncResult = await cloudSync.drainEmployeeCommandOutbox();
        }
        refreshSync(`employee_${action}_${syncResult?.status === 'completed' ? 'confirmed' : 'pending'}`);
      }).catch(() => {
        refreshSync(`employee_${action}_pending`);
      });
      refreshSync(`employee_${action}_deferred`);
      return localResult;
    }
    // The local lifecycle transition is already committed and safe to render.
    // Cloud remains the final authority, but a slow or unavailable server must
    // never keep the renderer IPC request (and therefore the UI button) pending.
    const submission = Promise.resolve().then(async () => {
      try {
        await cloudSync.submitEmployeeCommand(staged.command);
        refreshSync(`employee_${action}_confirmed`);
      } catch (error) {
        store.markEmployeeCommandAttempt?.({
          commandId,
          status: employeeCommandFailureStatus(error),
          error: employeeCommandFailureMessage(error),
        });
        refreshSync(`employee_${action}_pending`);
      }
    }).catch(() => {}).finally(() => {
      if (employeeCommandInFlight.get(commandId) === submission) employeeCommandInFlight.delete(commandId);
    });
    employeeCommandInFlight.set(commandId, submission);
    return localResult;
  }

  function executeLifecycleRequest(input = {}) {
    const action = String(input.action || '').trim();
    const agentInstanceId = String(input.agentInstanceId || '').trim();
    const agentFamilyId = canonicalEmployeeAgentFamilyId(input.agentFamilyId || '');
    const targetKey = agentInstanceId ? `instance:${agentInstanceId}` : `family:${agentFamilyId}`;
    const requestKey = `${action}:${targetKey}`;
    const existing = employeeLifecycleRequestInFlight.get(requestKey);
    if (existing) return existing;
    const execution = Promise.resolve()
      .then(() => executeCloudCommand({ ...input, agentFamilyId }))
      .finally(() => {
        if (employeeLifecycleRequestInFlight.get(requestKey) === execution) {
          employeeLifecycleRequestInFlight.delete(requestKey);
        }
      });
    employeeLifecycleRequestInFlight.set(requestKey, execution);
    return execution;
  }

  return {
    employeeOverview,
    async recruitEmployee({ agentFamilyId = '', commandId = '', expectedStateRevision } = {}) {
      const user = currentUser();
      return executeLifecycleRequest({ action: 'recruit', user, agentFamilyId, commandId, expectedStateRevision });
    },
    updateEmployeeProfile({ agentInstanceId = '', displayName = '', note = '' } = {}) {
      const user = currentUser();
      assertOwnedInstance(user.id, agentInstanceId);
      const instance = store.updateUserAgentProfile({ userId: user.id, agentInstanceId, displayName, note });
      refreshSync('employee_profile_updated');
      return { instance };
    },
    async deactivateEmployee({ agentInstanceId = '', commandId = '', expectedStateRevision, reason = 'user' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      return executeLifecycleRequest({ action: 'deactivate', user, agentFamilyId: instance.agentFamilyId, agentInstanceId: instance.id, commandId, expectedStateRevision, reason });
    },
    async reactivateEmployee({ agentInstanceId = '', commandId = '', expectedStateRevision } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      return executeLifecycleRequest({ action: 'reactivate', user, agentFamilyId: instance.agentFamilyId, agentInstanceId: instance.id, commandId, expectedStateRevision });
    },
    async retryEmployeeLifecycleSync({ agentInstanceId = '' } = {}) {
      const user = currentUser();
      if (agentInstanceId) assertOwnedInstance(user.id, agentInstanceId);
      if (typeof cloudSync?.drainEmployeeCommandOutbox !== 'function') {
        throw employeeError('employee_cloud_unavailable', 'Cloud employee synchronization is unavailable.');
      }
      const sync = await cloudSync.drainEmployeeCommandOutbox();
      return { sync, overview: await employeeOverview({ refreshCloud: false }) };
    },
    employeeRecruitmentEvents({ agentInstanceId = '', limit = 100 } = {}) {
      const user = currentUser();
      if (agentInstanceId) assertOwnedInstance(user.id, agentInstanceId);
      return store.listRecruitmentEvents({ userId: user.id, agentInstanceId, limit });
    },
    employeeMemoryDocuments({ agentInstanceId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const deviceId = currentDeviceId();
      const workspaceId = store.activeAccountWorkspace?.({ userId: user.id, deviceId })?.id || 'workspace_personal';
      store.ensureDefaultMemoryDocument?.({ agentInstanceId: instance.id, workspaceId });
      store.ensureDeviceContextState?.({
        deviceId, userId: user.id, agentInstanceId: instance.id, workspaceId,
      });
      return store.listMemoryDocuments({ agentInstanceId: instance.id, workspaceId }).map((document) => (
        store.getMemoryContextDetails?.({ memoryDocumentId: document.id })?.document || document
      ));
    },
    employeeMemoryDetails({ agentInstanceId = '', memoryDocumentId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) {
        throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      }
      assertWorkspaceDocument(user.id, document);
      return store.getMemoryContextDetails({ memoryDocumentId: document.id });
    },
    employeeMemoryVersions({ agentInstanceId = '', memoryDocumentId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) {
        throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      }
      assertWorkspaceDocument(user.id, document);
      const versions = store.listMemoryDocumentVersions?.({ memoryDocumentId: document.id }) || [];
      store.recordMemoryAccessAudit?.({ requesterUserId: user.id, requesterAgentInstanceId: instance.id,
        targetUserId: user.id, targetAgentInstanceId: instance.id, contextSpaceId: document.contextSpaceId,
        memoryDocumentId: document.id, memoryCloudKey: document.cloudKey, memoryDocumentVersionId: document.currentVersionId,
        action: 'read', reason: 'employee_memory_history', result: 'allowed', resultCode: 'ALLOWED' });
      return versions;
    },
    createEmployeeMemory({ agentInstanceId = '', displayName = '' } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      assertMemoryContextIdle(instance);
      const document = store.createNextGeneralMemoryDocument({ agentInstanceId: instance.id, displayName, deviceId: currentDeviceId() });
      refreshSync('employee_memory_created');
      return { document, ...memoryApplicationState(instance, { threadReset: false }) };
    },
    archiveEmployeeMemory({ agentInstanceId = '', memoryDocumentId = '' } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userAgentInstanceId !== instance.id || document.userId !== user.id) {
        throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      }
      assertWorkspaceDocument(user.id, document);
      const archived = store.archiveMemoryDocument({ memoryDocumentId: document.id });
      refreshSync('employee_memory_archived');
      return archived;
    },
    switchEmployeeMemory({
      agentInstanceId = '', memoryDocumentId = '', expectedStateRevision,
      expectedActiveContextSpaceId, expectedActiveMemoryDocumentId,
    } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      assertMemoryContextIdle(instance);
      const document = store.switchCurrentMemory({
        agentInstanceId: instance.id, memoryDocumentId, deviceId: currentDeviceId(), expectedStateRevision,
        expectedActiveContextSpaceId, expectedActiveMemoryDocumentId,
      });
      refreshSync('employee_memory_switched');
      return { document, context: store.getDeviceContextState({ deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id }),
        ...memoryApplicationState(instance, { threadReset: false }) };
    },
    clearEmployeeMemory({ agentInstanceId = '', sessionId = '', saveCurrentContext = false } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      assertMemoryContextIdle(instance);
      let checkpoint = null;
      if (saveCurrentContext && sessionId) {
        const session = store.getSession(sessionId);
        const activeWorkspaceId = store.activeAccountWorkspace?.({ userId: user.id, deviceId: currentDeviceId() })?.id || 'workspace_personal';
        if (!session || !auth.canAccessSession(user, session, activeWorkspaceId) || session.agentInstanceId !== instance.id) {
          throw employeeError('memory_context_session_mismatch', 'The active conversation does not belong to this Employee Agent.');
        }
        const contextState = store.getDeviceContextState({ deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id });
        const currentMemory = store.getMemoryDocument(contextState?.activeMemoryDocumentId || '');
        const messages = store.listMessages(session.id, {
          contextSpaceId: contextState?.activeContextSpaceId || '',
          includeAllContexts: false,
        });
        if (currentMemory && messages.length) {
          checkpoint = store.appendMemoryDocumentVersion({
            memoryDocumentId: currentMemory.id,
            content: conversationMemoryCheckpoint(currentMemory, session, messages),
            sourceKind: 'conversation_context_checkpoint',
            sourceId: session.id,
            reviewStatus: 'user_saved_context',
            createdBy: user.id,
          });
        }
      }
      const result = store.clearCurrentMemory({ agentInstanceId: instance.id, deviceId: currentDeviceId() });
      refreshSync('employee_memory_cleared');
      return { ...result, checkpoint, ...memoryApplicationState(instance, { threadReset: result.threadReset }) };
    },
    restoreEmployeeMemory({ agentInstanceId = '', memoryDocumentId = '' } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      assertWorkspaceDocument(user.id, document);
      const restored = store.restoreMemoryDocument({ memoryDocumentId: document.id });
      refreshSync('employee_memory_restored');
      return restored;
    },
    restoreAndSwitchEmployeeMemory({
      agentInstanceId = '', memoryDocumentId = '', expectedStateRevision,
      expectedActiveContextSpaceId, expectedActiveMemoryDocumentId,
    } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      assertMemoryContextIdle(instance);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      assertWorkspaceDocument(user.id, document);
      const restored = store.restoreAndSwitchCurrentMemory({
        agentInstanceId: instance.id, memoryDocumentId: document.id, deviceId: currentDeviceId(), expectedStateRevision,
        expectedActiveContextSpaceId, expectedActiveMemoryDocumentId,
      });
      refreshSync('employee_memory_restored_and_switched');
      return { document: restored, context: store.getDeviceContextState({ deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id }),
        ...memoryApplicationState(instance, { threadReset: false }) };
    },
    renameEmployeeMemory({ agentInstanceId = '', memoryDocumentId = '', displayName = '' } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      assertWorkspaceDocument(user.id, document);
      const renamed = store.renameMemoryDocument({ memoryDocumentId: document.id, displayName });
      refreshSync('employee_memory_renamed');
      return renamed;
    },
    employeeContextSpaces({ agentInstanceId = '', includeArchived = true } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      return {
        current: store.getDeviceContextState({ deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id }),
        account: store.getAgentContextState({ deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id }),
        items: store.listAgentContextSpaces({ userId: user.id, agentInstanceId: instance.id, includeArchived }),
      };
    },
    switchEmployeeContext({ agentInstanceId = '', contextSpaceId = '' } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const result = store.switchAgentContext({ deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id, contextSpaceId });
      return { ...result, ...memoryApplicationState(instance, { threadReset: result.threadReset }) };
    },
    employeeSessionHistory({ agentInstanceId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      return store.listAgentSessionHistory({ userId: user.id, agentInstanceId: instance.id });
    },
    employeeConversationOverview({ agentInstanceId = '' } = {}) {
      return conversationOverview(agentInstanceId);
    },
    openAgentConversation({ agentInstanceId = '' } = {}) {
      return conversationOverview(agentInstanceId);
    },
    agentConversationTimeline({ agentInstanceId = '', before = null, limit = 100 } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const context = store.getDeviceContextState({
        deviceId: currentDeviceId(), userId: user.id, agentInstanceId: instance.id,
      });
      return store.listAgentConversationTimeline?.({
        userId: user.id,
        agentInstanceId: instance.id,
        memoryDocumentId: context?.activeMemoryDocumentId || '',
        contextSpaceId: context?.activeContextSpaceId || '',
        before,
        limit,
      })
        || { windowId: `agent:${instance.id}`, agentInstanceId: instance.id, items: [], nextCursor: null };
    },
    employeeConversationHistoryGroup({ agentInstanceId = '', historyGroupId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const timeline = store.listAgentConversationTimeline?.({ userId: user.id, agentInstanceId: instance.id, limit: 200 })
        || { items: [] };
      return {
        redirected: true,
        windowId: timeline.windowId || `agent:${instance.id}`,
        legacyHistoryGroupId: String(historyGroupId || ''),
        group: null,
        messages: timeline.items.filter((item) => item.accessState === 'full').map((item) => item.message).filter(Boolean),
        timeline,
      };
    },
    async employeeLeadershipHistory({ agentInstanceId = '', limit = 30 } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      return cloudSync?.leadershipHistory?.(instance.id, { limit }) || { authority: 'cloud', items: [] };
    },
    async requestEmployeeLeadershipTrial({ agentInstanceId = '', role = 'task_lead', participantCount = 1, nodeCount = 1, departmentCount = 1, commandId = '', expectedStateRevision } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      if (!cloudSync?.requestLeadershipTrial) throw employeeError('leadership_cloud_unavailable', 'Cloud Leadership service is unavailable.');
      return cloudSync.requestLeadershipTrial({ agentInstanceId: instance.id, role, participantCount, nodeCount, departmentCount, commandId, expectedStateRevision });
    },
    async decideEmployeeLeadershipAction({ agentInstanceId = '', actionId = '', decision = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      const user = currentUser();
      assertOwnedInstance(user.id, agentInstanceId);
      if (!cloudSync?.decideLeadershipAction) throw employeeError('leadership_cloud_unavailable', 'Cloud Leadership service is unavailable.');
      return cloudSync.decideLeadershipAction(actionId, { agentInstanceId, decision, commandId, reason, expectedStateRevision });
    },
    async restoreEmployeeLeadership({ agentInstanceId = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      if (!cloudSync?.restoreLeadership) throw employeeError('leadership_cloud_unavailable', 'Cloud Leadership service is unavailable.');
      return cloudSync.restoreLeadership(instance.id, { commandId, reason, expectedStateRevision });
    },
    async employeeLeadershipAppeals({ agentInstanceId = '', status = '', limit = 50 } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      return cloudSync?.leadershipAppeals?.({ agentInstanceId: instance.id, status, limit }) || { authority: 'cloud', items: [] };
    },
    async submitEmployeeLeadershipAppeal({ agentInstanceId = '', leadershipActionId = '', appealKind = 'assessment', reason = '', commandId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      if (!cloudSync?.submitLeadershipAppeal) throw employeeError('leadership_cloud_unavailable', 'Cloud Leadership service is unavailable.');
      return cloudSync.submitLeadershipAppeal({ agentInstanceId: instance.id, leadershipActionId, appealKind, reason, commandId });
    },
    async leadershipGovernanceQueue() {
      const user = currentUser();
      if (user.role !== 'admin') throw employeeError('leadership_governance_required', 'Cloud governance approval is required.');
      return {
        actions: cloudSync?.stage8Projection?.('leadership:governance_actions')?.payload || [],
        appeals: cloudSync?.stage8Projection?.('leadership:governance_appeals')?.payload || [],
      };
    },
    async decideLeadershipGovernanceAction({ actionId = '', decision = '', commandId = '', reason = '', expectedStateRevision } = {}) {
      const user = currentUser();
      if (user.role !== 'admin') throw employeeError('leadership_governance_required', 'Cloud governance approval is required.');
      return cloudSync.decideLeadershipAction(actionId, { decision, commandId, reason, expectedStateRevision });
    },
    async decideLeadershipGovernanceAppeal({ appealId = '', decision = '', reason = '' } = {}) {
      const user = currentUser();
      if (user.role !== 'admin') throw employeeError('leadership_governance_required', 'Cloud governance approval is required.');
      return cloudSync.decideLeadershipAppeal(appealId, { decision, reason });
    },
    employeeMemoryConflicts({ agentInstanceId = '', memoryDocumentId = '' } = {}) {
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      return store.listMemoryConflicts({ memoryDocumentId: document.id });
    },
    resolveEmployeeMemoryConflict({ agentInstanceId = '', memoryDocumentId = '', versionId = '' } = {}) {
      assertMultiMemoryWritable(cloudSync);
      const user = currentUser();
      const instance = assertOwnedInstance(user.id, agentInstanceId);
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) throw employeeError('memory_document_owner_mismatch', 'Memory document does not belong to the Employee Agent.');
      const result = store.resolveMemoryConflict({ memoryDocumentId: document.id, versionId, createdBy: user.id });
      store.recordMemoryAccessAudit?.({ requesterUserId: user.id, requesterAgentInstanceId: instance.id,
        targetUserId: user.id, targetAgentInstanceId: instance.id, contextSpaceId: document.contextSpaceId,
        memoryDocumentId: document.id, memoryCloudKey: document.cloudKey, memoryDocumentVersionId: versionId,
        action: 'conflict_resolve', reason: 'user_selected_branch', result: 'allowed', resultCode: 'ALLOWED' });
      refreshSync('employee_memory_conflict_resolved');
      return result;
    },
  };
}

function latestEmployeeTaskEvent(events = []) {
  return sortEmployeeTaskEvents(events).at(-1) || null;
}

function sortEmployeeTaskEvents(events = []) {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.updated_at || left.createdAt || left.created_at || '') || 0;
    const rightTime = Date.parse(right.updatedAt || right.updated_at || right.createdAt || right.created_at || '') || 0;
    return leftTime - rightTime || String(left.id || left.eventId || '').localeCompare(String(right.id || right.eventId || ''));
  });
}

function employeeVisibleTaskText(value = '') {
  return sanitizePublicWorkStatusText(value, 500);
}

function employeeTaskEventVisible(event = {}) {
  const activityType = String(event.payload?.activityType || '').toLowerCase();
  return activityType !== 'reasoning'
    && !/prompt|protocol|raw_response/i.test(String(event.eventType || event.event_type || ''));
}

function selectEmployeeActiveTaskNode(nodes = []) {
  const rank = { running: 0, blocked: 1, waiting: 1, retry_wait: 1, queued: 2, ready: 3, pending: 4 };
  return [...nodes].filter((node) => Object.hasOwn(rank, String(node.status || '')))
    .sort((left, right) => (rank[String(left.status || '')] ?? 9) - (rank[String(right.status || '')] ?? 9)
      || String(right.updatedAt || right.updated_at || '').localeCompare(String(left.updatedAt || left.updated_at || '')))[0]
    || nodes.at(-1) || null;
}

function employeeRosterItem(store, instance = {}, cloudSync = null) {
  const cloudStatus = cloudSync?.status?.() || {};
  const deviceId = cloudStatus.deviceId || cloudStatus.device_id || 'local';
  const workspaceId = store.activeAccountWorkspace?.({ userId: instance.userId, deviceId })?.id || 'workspace_personal';
  const workQueue = store.listAgentWorkQueue?.({
    userId: instance.userId, agentInstanceId: instance.id, workspaceId,
    statuses: ['queued', 'running'], limit: 100,
  }) || [];
  const authoritativeStatus = store.getAgentAvailability?.({ userId: instance.userId, agentInstanceId: instance.id, workspaceId }) || null;
  const reservedTaskCandidate = authoritativeStatus?.reservation?.taskRunId
    ? store.getTaskRun?.(authoritativeStatus.reservation.taskRunId)
    : null;
  const reservedTask = reservedTaskCandidate?.workspaceId === workspaceId ? reservedTaskCandidate : null;
  const baseCurrentWork = workQueue.find((item) => item.status === 'running')
    || workQueue.find((item) => item.status === 'queued')
    || (reservedTask ? { id: authoritativeStatus.reservation.id, title: reservedTask.title, status: 'reserved', taskRunId: reservedTask.id } : null);
  const activeTaskRunId = String(baseCurrentWork?.taskRunId || baseCurrentWork?.payload?.taskRunId || reservedTask?.id || '');
  const activeTask = activeTaskRunId ? store.getTaskRun?.(activeTaskRunId) || null : null;
  const activeNodeIds = new Set((activeTask?.nodes || []).filter((node) => (
    String(node.agentInstanceId || node.agent_instance_id || '').trim() === instance.id
  )).map((node) => String(node.id || '')).filter(Boolean));
  const latestProgressEvent = latestEmployeeTaskEvent((activeTask?.events || []).filter((event) => (
    employeeTaskEventVisible(event)
    && activeNodeIds.has(String(event.taskNodeId || event.task_node_id || ''))
    && ['node_activity', 'node_progress'].includes(String(event.eventType || event.event_type || ''))
    && String(event.summary || '').trim()
  )));
  const currentWork = baseCurrentWork && latestProgressEvent ? {
    ...baseCurrentWork,
    title: activeTask?.title || baseCurrentWork.title || '',
    summary: employeeVisibleTaskText(latestProgressEvent.summary),
    currentAction: employeeVisibleTaskText(latestProgressEvent.summary),
    updatedAt: latestProgressEvent.updatedAt || latestProgressEvent.createdAt || baseCurrentWork.updatedAt || '',
  } : baseCurrentWork;
  store.ensureDefaultMemoryDocument?.({ agentInstanceId: instance.id, workspaceId });
  const contextState = store.getDeviceContextState?.({
    deviceId, userId: instance.userId, agentInstanceId: instance.id, workspaceId,
  });
  const memoryDocuments = store.listMemoryDocuments({ agentInstanceId: instance.id, workspaceId });
  const currentMemory = memoryDocuments.find((item) => item.id === contextState?.activeMemoryDocumentId)
    || memoryDocuments.find((item) => item.scope === 'general' && item.lifecycleState === 'active') || memoryDocuments[0] || null;
  const recentEvolution = store.listPersonalEvolutionProposals?.({ agentInstanceId: instance.id, limit: 1 })?.[0] || null;
  const lifecycleCommand = instance.lastEmployeeCommandId
    ? store.getEmployeeCommandOutbox?.({ userId: instance.userId, commandId: instance.lastEmployeeCommandId })
    : null;
  const employeeProgression = progressionSyncForEmployee(cloudStatus.employeeProgression || {}, instance.id);
  return {
    ...instance,
    family: instance.family || store.getAgentFamily(instance.agentFamilyId),
    currentWork,
    availability: currentWork ? 'working' : 'idle',
    workState: currentWork?.status === 'running' ? 'running'
      : currentWork?.status === 'queued' ? 'queued' : currentWork ? 'reserved' : '',
    updatedAt: currentWork?.updatedAt || instance.updatedAt || '',
    queueDepth: workQueue.filter((item) => item.status === 'queued').length,
    queue: workQueue,
    currentMemory,
    currentContext: contextState,
    memoryDocumentCount: memoryDocuments.length,
    recentEvolution,
    performance: cloudSync?.stage8Projection?.(`performance:${instance.id}`)?.payload || null,
    leadership: cloudSync?.stage8Projection?.(`leadership:${instance.id}`)?.payload || null,
    leadershipActions: cloudSync?.stage8Projection?.(`leadership_actions:${instance.id}`)?.payload || [],
    leadershipAppeals: cloudSync?.stage8Projection?.(`leadership_appeals:${instance.id}`)?.payload || [],
    progressionSync: employeeProgression,
    availableMarketVersions: cloudSync?.stage8Projection?.(`market_versions:${instance.agentFamilyId}`)?.payload || [],
    marketEffectiveSkill: cloudSync?.stage8Projection?.(`effective_skill:${instance.id}`)?.payload || null,
    pendingTargetState: instance.pendingTargetState || '',
    lifecycleSync: lifecycleCommand ? {
      status: lifecycleCommand.status,
      targetState: instance.pendingTargetState || '',
      commandId: lifecycleCommand.commandId,
      attemptCount: lifecycleCommand.attemptCount,
      lastError: lifecycleCommand.lastError,
      retryable: ['pending', 'sending', 'failed', 'blocked_auth', 'blocked_incompatible_cloud'].includes(lifecycleCommand.status),
    } : null,
  };
}

export function progressionSyncForEmployee(summary = {}, agentInstanceId = '') {
  const perInstance = summary?.instances && typeof summary.instances === 'object'
    ? summary.instances[agentInstanceId]
    : null;
  if (perInstance) return { ...summary, ...perInstance };
  if (summary?.instances && typeof summary.instances === 'object') {
    return { ...summary, lastError: '' };
  }
  return summary || {};
}

function employeeCommandResult(result = {}, overview = {}) {
  const status = result.status === 'rejected'
    ? 'rejected'
    : result.status === 'pending_cloud_confirmation' || result.instance?.employmentState === 'pending_cloud_confirmation'
      ? 'pending_cloud_confirmation'
      : result.status === 'conflict' || result.instance?.employmentState === 'conflict'
        ? 'conflict'
        : 'confirmed';
  return {
    ...result,
    status,
    commandId: result.commandId || result.event?.commandId || '',
    overview,
  };
}

function employeeError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  error.details = details;
  return error;
}

function conversationMemoryCheckpoint(memory = {}, session = {}, messages = []) {
  const savedAt = new Date().toISOString();
  const transcript = messages
    .filter((message) => ['user', 'assistant'].includes(message.role) && String(message.content || '').trim())
    .slice(-60)
    .map((message) => {
      const speaker = message.role === 'user' ? '用户' : 'Agent';
      return `### ${speaker}\n${clipMemoryContext(message.content)}`;
    })
    .join('\n\n');
  const checkpoint = [
    `## 已保存上下文 · ${savedAt}`,
    `- 会话：${session.title || '主会话'}`,
    `- context_space_id：${memory.contextSpaceId || ''}`,
    '',
    transcript || '当前上下文没有可保存的对话内容。',
  ].join('\n');
  return `${String(memory.content || '').trimEnd()}\n\n${checkpoint}\n`.slice(-48_000);
}

function clipMemoryContext(value = '') {
  const text = String(value || '').trim();
  return text.length > 2_400 ? `${text.slice(0, 2_400)}\n…` : text;
}

function employeeCommandFailureStatus(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '');
  if (status === 401 || status === 403
    || /grant|auth|forbidden|unauthorized|device_approval|device_not_approved/i.test(code)) return 'blocked_auth';
  if (code === 'employee_cloud_contract_unsupported' || status === 404) return 'blocked_incompatible_cloud';
  if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return 'failed_terminal';
  return 'failed';
}

function employeeCommandFailureMessage(error) {
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
  const message = String(error?.message || error || 'Cloud employee synchronization failed.').trim();
  return code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
}

function employeeCloudMutationReadiness(user = {}, cloudStatus = {}, lastSyncError = '') {
  const remoteUserId = String(user.remoteId || user.remote_id || '').trim();
  const configuredUserId = String(cloudStatus.userId || cloudStatus.user_id || '').trim();
  const serverUrl = String(cloudStatus.serverUrl || cloudStatus.server_url || '').trim();
  if (!user.remoteBound || !remoteUserId) {
    return {
      enabled: false,
      code: 'cloud_auth_required',
      message: '请先登录并绑定云端账号，再修改员工启用状态。',
    };
  }
  if (!serverUrl || !cloudStatus.configured || !configuredUserId || configuredUserId !== remoteUserId) {
    return {
      enabled: false,
      code: 'cloud_auth_required',
      message: '云端登录状态尚未就绪，请重新登录后再修改员工启用状态。',
    };
  }
  if (['cloud_auth_required', 'social_session_expired', 'access_token_expired', 'refresh_token_expired'].includes(lastSyncError)) {
    return {
      enabled: false,
      code: lastSyncError,
      message: '云端登录或设备授权已失效，请重新登录；本地员工数据不会被删除，登录后会自动继续同步。',
    };
  }
  if (lastSyncError === 'device_approval_pending') {
    return {
      enabled: false,
      code: lastSyncError,
      message: '当前设备正在等待另一台已授权设备批准；本地员工数据不会被删除，批准后会自动继续同步。',
    };
  }
  const capabilities = cloudStatus.employeeCapabilities || {};
  if (!Object.keys(capabilities).length) {
    return {
      enabled: false,
      code: 'employee_cloud_capabilities_pending',
      message: '通信服务器能力尚未完成同步，请检查网络后重试；本地员工数据不会被删除。',
    };
  }
  if (Number(capabilities.contractVersion || 0) < 2 || capabilities.profileSequenceAuthority !== 'server') {
    return {
      enabled: false,
      code: 'employee_cloud_contract_unsupported',
      message: '通信服务器尚未支持唯一员工实例序号，请先升级服务器后再修改员工状态。',
    };
  }
  return { enabled: true, code: 'employee_cloud_ready', message: '' };
}

function employeeSyncErrorCode(error) {
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
  if (/^[a-z][a-z0-9_.:-]{0,79}$/i.test(code)) return code;
  const status = Number(error?.status || error?.body?.status || 0);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return `employee_cloud_http_${status}`;
  return 'employee_cloud_unavailable';
}

function assertMultiMemoryWritable(cloudSync) {
  return cloudSync?.status?.().multiMemory || { enabled: false, readOnly: true, code: 'cloud_not_configured' };
}

function mergeRecruitableFamilies(local = [], cloud = []) {
  if (!Array.isArray(cloud)) return local;
  const cloudById = new Map(cloud.map((item) => [item.id, item]));
  return local.filter((family) => cloudById.has(family.id)).map((family) => {
    const remote = cloudById.get(family.id);
    const remoteInstances = Array.isArray(remote.instances)
      ? remote.instances
      : remote.instance ? [remote.instance] : [];
    return {
      ...family,
      cloud: remote,
      cloudInstances: remoteInstances,
      instanceCount: Math.max(Number(family.instanceCount || 0), Number(remote.instanceCount || remoteInstances.length || 0)),
      activeInstanceCount: Math.max(Number(family.activeInstanceCount || 0), Number(remote.activeInstanceCount
        || remoteInstances.filter((instance) => instance.employmentState === 'active').length || 0)),
    };
  });
}
