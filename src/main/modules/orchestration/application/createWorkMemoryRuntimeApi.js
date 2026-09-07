import { leadershipAssignmentEligibility } from '../../../../shared/evolution/leadership.js';

export function createWorkMemoryRuntimeApi({ auth, store, socialRelay = null, cloudSync = null } = {}) {
  if (!auth || !store) throw new Error('Work Memory Runtime API requires auth and Store.');

  const currentUser = () => auth.requireUser();
  const requireOwnedAgent = (userId, agentInstanceId, label = 'Agent') => {
    const instance = store.getUserAgentInstance(agentInstanceId || '');
    if (!instance || instance.userId !== userId) {
      throw runtimeError('AGENT_OWNERSHIP_REQUIRED', `${label} does not belong to the current user.`);
    }
    return instance;
  };
  const requireLocalWorkScope = (userId, workScopeId) => {
    if (!workScopeId) throw runtimeError('WORK_SCOPE_REQUIRED', 'Exact workScopeId is required.');
    const scope = store.getWorkScope(workScopeId);
    if (!scope) throw runtimeError('WORK_SCOPE_NOT_FOUND', 'Work scope not found.');
    if (scope.ownerUserId !== userId) {
      throw runtimeError('CLOUD_AUTH_REQUIRED', 'Cross-user work access must use cloud/uBuddy authorization.');
    }
    return scope;
  };
  const publicationRetryAt = (attemptCount = 1) => {
    const delayMinutes = Math.min(30, [1, 2, 4, 8, 15][Math.min(4, Math.max(0, Number(attemptCount || 1) - 1))] || 30);
    return new Date(Date.now() + (delayMinutes * 60_000)).toISOString();
  };
  const attemptPublication = async (outbox) => {
    if (!outbox) return { status: 'not_federated' };
    if (!socialRelay?.connected?.()) {
      return { status: 'unavailable', reason: 'not_connected', outbox };
    }
    if (!store.claimWorkMemoryPublication({ id: outbox.id })) {
      const current = store.getWorkMemoryPublicationOutbox({ id: outbox.id });
      return {
        status: current?.status === 'published' ? 'published' : (current?.status || 'busy'),
        reason: current?.status === 'sending' ? 'already_sending' : '',
        outbox: current,
      };
    }
    try {
      const publication = store.cloudWorkMemoryPublication({
        memoryDocumentVersionId: outbox.memoryDocumentVersionId,
      });
      const scope = store.getWorkScope(outbox.workScopeId);
      if (scope?.ownerUserId === outbox.userId && ['task_lead', 'team_lead', 'cross_team_lead'].includes(publication.participant?.role)) {
        const assignment = store.getWorkLeadershipAssignment?.({
          workScopeId: outbox.workScopeId,
          agentInstanceId: publication.version.agentInstanceId,
          at: publication.version.publishedAt,
        });
        if (assignment) {
          await socialRelay.appointWorkLeader({
            federationType: publication.federationType,
            federationId: publication.federationId,
            assignmentId: assignment.id,
            targetUserId: outbox.userId,
            targetAgentInstanceId: publication.version.agentInstanceId,
            role: assignment.role,
            leadershipLevelSnapshot: assignment.leadershipLevelSnapshot,
            permissionSnapshot: assignment.permissionSnapshot,
            validFrom: assignment.validFrom,
            validUntil: assignment.validUntil,
          });
        }
      }
      const response = await socialRelay.publishWorkMemory(publication);
      const completed = store.completeWorkMemoryPublication({ id: outbox.id });
      return { status: 'published', response, outbox: completed };
    } catch (error) {
      const code = error?.code || 'CLOUD_WORK_MEMORY_PUBLISH_FAILED';
      const failed = store.failWorkMemoryPublication({
        id: outbox.id,
        error: `${code}: ${String(error?.message || error)}`,
        retryAt: publicationRetryAt(Number(outbox.attemptCount || 0) + 1),
      });
      return {
        status: code === 'CLOUD_KEY_ENVELOPE_UNAVAILABLE' ? 'pending' : 'failed',
        reason: code,
        message: String(error?.message || error),
        outbox: failed,
      };
    }
  };
  const recordPreflightDenial = (input, error, requesterUserId = '') => {
    store.recordWorkMemoryAccessDecision?.({
      requesterUserId,
      requesterAgentInstanceId: input.requesterAgentInstanceId || '',
      targetAgentInstanceId: input.targetAgentInstanceId || '',
      workScopeId: input.workScopeId || '',
      memoryDocumentId: input.memoryDocumentId || '',
      memoryDocumentVersionId: input.memoryDocumentVersionId || '',
      reason: input.reason || '',
      result: 'denied',
      resultCode: error?.code || 'WORK_MEMORY_ACCESS_DENIED',
    });
  };

  return {
    workMemoryProgress({ workScopeId = '', requesterAgentInstanceId = '' } = {}) {
      const user = currentUser();
      requireLocalWorkScope(user.id, workScopeId);
      requireOwnedAgent(user.id, requesterAgentInstanceId, 'Requester Agent');
      return store.listWorkParticipantProgress({ workScopeId, requesterAgentInstanceId });
    },

    async publishWorkMemory({
      workScopeId = '',
      agentInstanceId = '',
      memoryDocumentId = '',
      visibility = 'work_collaborators',
      content,
      sourceCursor = '',
    } = {}) {
      const user = currentUser();
      const scope = requireLocalWorkScope(user.id, workScopeId);
      const instance = requireOwnedAgent(user.id, agentInstanceId, 'Publishing Agent');
      const document = store.getMemoryDocument(memoryDocumentId);
      if (!document || document.userId !== user.id || document.userAgentInstanceId !== instance.id) {
        throw runtimeError('MEMORY_OWNERSHIP_REQUIRED', 'Memory document does not belong to the publishing Agent.');
      }
      const published = store.publishWorkMemoryVersion({
        workScopeId,
        agentInstanceId: instance.id,
        memoryDocumentId: document.id,
        visibility,
        content,
        sourceCursor,
      });
      if (!scope.federationType || !scope.federationId) {
        return { ...published, cloud: { status: 'not_federated' } };
      }
      return { ...published, cloud: await attemptPublication(published.outbox) };
    },

    workMemoryPublicationStatus({ workScopeId = '', status = '', limit = 100 } = {}) {
      const user = currentUser();
      if (workScopeId) requireLocalWorkScope(user.id, workScopeId);
      return store.listWorkMemoryPublicationOutbox({
        userId: user.id,
        workScopeId,
        status,
        limit,
      });
    },

    workMemoryAudits({ workScopeId = '', requesterAgentInstanceId = '', limit = 200 } = {}) {
      const user = currentUser();
      requireLocalWorkScope(user.id, workScopeId);
      if (requesterAgentInstanceId) requireOwnedAgent(user.id, requesterAgentInstanceId, 'Requester Agent');
      return store.listWorkMemoryAccessAudits({ workScopeId, requesterAgentInstanceId, limit });
    },

    async flushWorkMemoryPublications({ limit = 20 } = {}) {
      let user;
      try {
        user = currentUser();
      } catch {
        return { status: 'skipped', reason: 'not_authenticated', attempted: 0, published: 0, failed: 0 };
      }
      if (!socialRelay?.connected?.()) {
        return { status: 'skipped', reason: 'not_connected', attempted: 0, published: 0, failed: 0 };
      }
      store.recoverStaleWorkMemoryPublications?.({
        userId: user.id,
        staleBefore: new Date(Date.now() - (5 * 60_000)).toISOString(),
      });
      const due = store.listWorkMemoryPublicationOutbox({
        userId: user.id,
        dueOnly: true,
        limit: Math.max(1, Math.min(100, Number(limit || 20))),
      });
      const results = [];
      for (const item of due) results.push(await attemptPublication(item));
      return {
        status: 'completed',
        attempted: results.length,
        published: results.filter((item) => item.status === 'published').length,
        failed: results.filter((item) => ['failed', 'pending'].includes(item.status)).length,
        results,
      };
    },

    async appointWorkMemoryLeader({
      workScopeId = '',
      targetUserId = '',
      targetAgentInstanceId = '',
      role = 'task_lead',
      leadershipLevelSnapshot = '',
      assignmentMode = 'normal',
      limitSnapshot = {},
      permissionSnapshot = {},
      appointedByAgentInstanceId = '',
      validFrom = '',
      validUntil = '',
      participantCount = 1,
      nodeCount = 1,
      taskGroupCount = 1,
      departmentCount = 1,
    } = {}) {
      const user = currentUser();
      const scope = requireLocalWorkScope(user.id, workScopeId);
      const resolvedTargetUserId = targetUserId || user.id;
      if (appointedByAgentInstanceId) requireOwnedAgent(user.id, appointedByAgentInstanceId, 'Appointing Agent');
      let local = null;
      if (resolvedTargetUserId === user.id) {
        requireOwnedAgent(user.id, targetAgentInstanceId, 'Target Agent');
        const leadership = cloudSync?.stage8Projection?.(`leadership:${targetAgentInstanceId}`)?.payload || null;
        if (leadership) {
          const performance = cloudSync?.stage8Projection?.(`performance:${targetAgentInstanceId}`)?.payload || {};
          const approvedTrial = assignmentMode === 'trial'
            ? (cloudSync?.stage8Projection?.(`leadership_actions:${targetAgentInstanceId}`)?.payload || [])
              .find((item) => item.id === permissionSnapshot?.trialActionId && item.action === 'trial_approved' && item.status === 'approved')
            : null;
          const eligibility = leadershipAssignmentEligibility({ level: leadership.level, status: leadership.status, role, assignmentMode,
            participantCount, nodeCount, taskGroupCount, departmentCount, ownerApproved: assignmentMode !== 'trial' || Boolean(approvedTrial),
            governanceApproved: assignmentMode !== 'trial' || Boolean(approvedTrial), professionalLevel: performance.level || '',
            professionalProvisional: performance.provisional !== false });
          if (!eligibility.eligible) throw runtimeError('LEADERSHIP_ASSIGNMENT_INELIGIBLE', `Leadership assignment is not eligible: ${eligibility.reasons.join(', ')}`);
          leadershipLevelSnapshot = leadership.level;
          limitSnapshot = eligibility.caps;
        }
        local = store.appointWorkLeader({
          workScopeId,
          agentInstanceId: targetAgentInstanceId,
          role,
          leadershipLevelSnapshot,
          assignmentMode,
          limitSnapshot,
          permissionSnapshot,
          appointedBy: appointedByAgentInstanceId || user.id,
          validFrom,
          validUntil,
        });
      }
      if (!scope.federationType || !scope.federationId) {
        if (resolvedTargetUserId !== user.id) {
          throw runtimeError('WORK_FEDERATION_REQUIRED', 'A remote leader can only be appointed inside federated work.');
        }
        return { local, cloud: { status: 'not_federated' } };
      }
      if (!socialRelay?.connected?.()) return { local, cloud: { status: 'unavailable', reason: 'not_connected' } };
      try {
        const response = await socialRelay.appointWorkLeader({
          federationType: scope.federationType,
          federationId: scope.federationId,
          assignmentId: local?.id || '',
          targetUserId: resolvedTargetUserId,
          targetAgentInstanceId,
          role,
          leadershipLevelSnapshot,
          assignmentMode,
          limitSnapshot,
          permissionSnapshot,
          validFrom,
          validUntil,
            participantCount,
            nodeCount,
            taskGroupCount,
            departmentCount,
        });
        return { local, cloud: { status: 'appointed', response } };
      } catch (error) {
        return { local, cloud: cloudMutationFailure(error, 'CLOUD_WORK_LEADERSHIP_APPOINT_FAILED') };
      }
    },

    async revokeWorkMemoryLeader({
      workScopeId = '',
      targetUserId = '',
      targetAgentInstanceId = '',
      revokedAt = '',
    } = {}) {
      const user = currentUser();
      const scope = requireLocalWorkScope(user.id, workScopeId);
      const resolvedTargetUserId = targetUserId || user.id;
      let local = null;
      if (resolvedTargetUserId === user.id) {
        requireOwnedAgent(user.id, targetAgentInstanceId, 'Target Agent');
        local = store.revokeWorkLeader({ workScopeId, agentInstanceId: targetAgentInstanceId, revokedAt });
      }
      if (!scope.federationType || !scope.federationId) {
        if (resolvedTargetUserId !== user.id) {
          throw runtimeError('WORK_FEDERATION_REQUIRED', 'A remote leader can only be revoked inside federated work.');
        }
        return { local, cloud: { status: 'not_federated' } };
      }
      if (!socialRelay?.connected?.()) return { local, cloud: { status: 'unavailable', reason: 'not_connected' } };
      try {
        const response = await socialRelay.revokeWorkLeader({
          federationType: scope.federationType,
          federationId: scope.federationId,
          targetUserId: resolvedTargetUserId,
          targetAgentInstanceId,
          revokedAt,
        });
        return { local, cloud: { status: 'revoked', response } };
      } catch (error) {
        return { local, cloud: cloudMutationFailure(error, 'CLOUD_WORK_LEADERSHIP_REVOKE_FAILED') };
      }
    },

    async readWorkMemory({
      workScopeId = '',
      requesterAgentInstanceId = '',
      targetAgentInstanceId = '',
      memoryDocumentId = '',
      memoryDocumentVersionId = '',
      reason = '',
    } = {}) {
      const input = {
        workScopeId, requesterAgentInstanceId, targetAgentInstanceId,
        memoryDocumentId, memoryDocumentVersionId, reason,
      };
      let user = null;
      let localStoreReadInvoked = false;
      try {
        user = currentUser();
        const scope = requireLocalWorkScope(user.id, workScopeId);
        requireOwnedAgent(user.id, requesterAgentInstanceId, 'Requester Agent');
        const target = store.getUserAgentInstance(targetAgentInstanceId || '');
        if (target?.userId === user.id) {
          localStoreReadInvoked = true;
          return store.readCollaboratorWorkMemory(input);
        }
        if (!scope.federationType || !scope.federationId) {
          throw runtimeError('WORK_FEDERATION_REQUIRED', 'Cross-user work Memory requires an exact delegation or collaboration-group federation.');
        }
        if (!socialRelay?.connected?.()) {
          throw runtimeError('CLOUD_AUTH_REQUIRED', 'Cross-user work Memory reads require an authenticated cloud/uBuddy connection.');
        }
        return await socialRelay.readWorkMemory({
          federationType: scope.federationType,
          federationId: scope.federationId,
          requesterAgentInstanceId,
          targetAgentInstanceId,
          memoryDocumentId,
          memoryDocumentVersionId,
          reason,
        });
      } catch (error) {
        if (!localStoreReadInvoked) recordPreflightDenial(input, error, user?.id || '');
        throw error;
      }
    },
  };
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cloudMutationFailure(error, fallbackCode) {
  return {
    status: 'failed',
    reason: error?.code || fallbackCode,
    message: String(error?.message || error),
  };
}
