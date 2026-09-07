import { createCollaborationGroupRuntimeApi } from './createCollaborationGroupRuntimeApi.js';
import { createDelegationRuntimeApi } from './createDelegationRuntimeApi.js';

export function createCollaborationWorkspaceRuntimeApi(context) {
  const runtimeState = {
    closed: false,
    socialPollRunning: false,
    socialPollCompletion: null,
    resolveSocialPollCompletion: null,
    autoProcessingDelegations: new Set(),
    delegationIntakeJobs: new Map(),
    delegationIntakeQueue: [],
    delegationIntakeActiveCount: 0,
    delegationProcessingLocks: new Map(),
    delegationExecutionLeases: new Map(),
    delegationExecutionLeaseTimers: new Map(),
    delegationExecutionLeaseRetryTimers: new Map(),
    delegationExecutionLeaseRenewals: new Map(),
  };
  const sharedContext = { ...context, runtimeState };
  return {
    ...createCollaborationGroupRuntimeApi(sharedContext),
    ...createDelegationRuntimeApi(sharedContext),
    shutdownCollaborationRuntime() {
      runtimeState.closed = true;
      for (const timer of runtimeState.delegationExecutionLeaseTimers.values()) clearInterval(timer);
      runtimeState.delegationExecutionLeaseTimers.clear();
      for (const timer of runtimeState.delegationExecutionLeaseRetryTimers.values()) clearTimeout(timer);
      runtimeState.delegationExecutionLeaseRetryTimers.clear();
      runtimeState.delegationExecutionLeaseRenewals.clear();
    },
  };
}
