import assert from 'node:assert/strict';

import { createNetworkWorkspaceController } from '../src/renderer/app/features/network/workspaceController.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createHarness(workspaceRequest, { refreshFails = false } = {}) {
  const delegationId = 'delegation-send-smoke';
  const input = { value: '请制作一份可编辑 PPT。' };
  const state = {
    currentUser: { id: 'recipient' },
    networkDelegationId: delegationId,
    networkBusyDelegationId: '',
    networkDelegationCommentDrafts: { [delegationId]: input.value },
    networkDelegationPendingMessages: {},
    networkDelegationEditingMessageId: '',
    networkDelegationUBuddyEnabled: {},
    networkConversationMessages: [],
    networkDelegationMemory: null,
    networkDelegationRunsById: {},
    agentDelegations: [{ id: delegationId, requesterUserId: 'requester', recipientUserId: 'recipient' }],
    attachments: [],
  };
  const controller = createNetworkWorkspaceController({
    api: {
      collaborationWorkspaceMessage: workspaceRequest,
      collaborationWorkspaceMessages: async () => {
        if (refreshFails) throw new Error('refresh failed');
        return [];
      },
      delegationTaskMemory: async () => null,
      cancelCollaborationWorkspaceWork: async () => ({ ok: true, cancelled: true }),
    },
    state,
    render: () => {},
    notify: () => {},
    userErrorMessage: (error) => error?.message || String(error),
    readyAttachmentsForSend: async (items) => items,
    currentModelValue: () => '',
    currentReasoningValue: () => '',
    persistComposerDrafts: () => {},
    focusActiveComposerInput: () => {},
    documentRef: {
      activeElement: null,
      getElementById: (id) => id === 'network-delegation-comment-input' ? input : null,
      querySelector: () => null,
    },
    windowRef: { confirm: () => true },
    setTimer: (callback) => callback(),
  });
  return { controller, delegationId, input, state };
}

{
  const request = deferred();
  const harness = createHarness(() => request.promise);
  const send = harness.controller.sendDelegationComment({
    preventDefault() {},
    currentTarget: { dataset: { delegationId: harness.delegationId } },
  });
  await Promise.resolve();
  assert.equal(harness.state.networkDelegationCommentDrafts[harness.delegationId], '', 'the submitted text must leave the composer immediately');
  assert.equal(harness.state.networkBusyDelegationId, '', 'sending must not lock the workspace composer');
  assert.equal(harness.state.networkDelegationPendingMessages[harness.delegationId][0].content, harness.input.value);
  harness.state.networkDelegationCommentDrafts[harness.delegationId] = '下一条消息草稿';
  request.resolve({
    ok: true,
    queued: true,
    receipt: { workId: 'workspace-work-1', deliveryStatus: 'queued', metadata: { delegationId: harness.delegationId, surface: 'delegation_workspace' }, events: [] },
    messages: [{ id: 'saved', role: 'user', content: harness.input.value, metadata: { delegationId: harness.delegationId, privateTaskWorkspace: true } }],
  });
  await send;
  assert.equal(harness.state.networkBusyDelegationId, '');
  assert.equal(harness.state.networkDelegationPendingMessages[harness.delegationId], undefined);
  assert.equal(harness.state.networkDelegationCommentDrafts[harness.delegationId], '下一条消息草稿', 'typing during processing must not be erased by the completed request');
  assert.equal(harness.state.networkDelegationRunsById[harness.delegationId][0].workId, 'workspace-work-1');
  await harness.controller.cancelDelegationWorkspaceRun(harness.delegationId, 'workspace-work-1');
  assert.equal(harness.state.networkDelegationRunsById[harness.delegationId].length, 0);
}

{
  const harness = createHarness(async () => { throw new Error('IPC failed'); }, { refreshFails: true });
  await harness.controller.sendDelegationComment({
    preventDefault() {},
    currentTarget: { dataset: { delegationId: harness.delegationId } },
  });
  assert.equal(harness.state.networkBusyDelegationId, '', 'a failed send must always release the composer lock');
  assert.equal(harness.state.networkDelegationCommentDrafts[harness.delegationId], harness.input.value, 'a message that was not confirmed by storage must return to the composer');
  assert.equal(harness.state.networkDelegationPendingMessages[harness.delegationId][0].metadata.sendFailed, true);
}

console.log('delegation send state smoke passed');
