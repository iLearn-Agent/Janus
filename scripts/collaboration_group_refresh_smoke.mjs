import assert from 'node:assert/strict';
import { createCollaborationController } from '../src/renderer/app/features/collaboration/collaborationController.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createHarness({ collaborationGroup, collaborationOverview, collaborationTaskAction } = {}) {
  const state = {
    currentUser: { id: 'user-1' },
    activeAccountWorkspace: { id: 'workspace_personal' },
    workspaceSwitchGeneration: 0,
    collaborationGroupId: 'group-1',
    collaborationGroupDetail: {
      group: { id: 'group-1', title: 'Existing group' },
      messages: [{ id: 'old-message', content: 'Existing message' }],
      members: [],
      tasks: [],
    },
    collaborationOverview: { groups: [], tasks: [] },
    agentDelegations: [],
    collaborationTaskActionBusyById: {},
    networkConversationDrafts: {},
    networkPanelOpen: true,
  };
  let renderCount = 0;
  const notifications = [];
  const controller = createCollaborationController({
    api: {
      collaborationGroup: collaborationGroup || (async () => state.collaborationGroupDetail),
      collaborationOverview: collaborationOverview || (async () => state.collaborationOverview),
      collaborationTaskAction: collaborationTaskAction || (async () => ({ ok: true })),
    },
    state,
    render: () => { renderCount += 1; },
    renderPreservingNetworkComposer: () => { renderCount += 1; },
    userErrorMessage: (error) => error?.message || String(error),
    notify: (message, tone) => { notifications.push({ message, tone }); },
    preserveChatDraftFromInput: () => {},
    scrollMessagesToBottom: () => {},
    focusChatInputAtEnd: () => {},
    windowRef: { prompt: () => '', confirm: () => true },
  });
  return { controller, state, notifications, renderCount: () => renderCount };
}

{
  const pending = deferred();
  const harness = createHarness({ collaborationOverview: async () => pending.promise });
  const refresh = harness.controller.refreshCollaborationOverview();
  harness.state.workspaceSwitchGeneration = 1;
  harness.state.activeAccountWorkspace = { id: 'workspace_org_next' };
  harness.state.collaborationOverview = { groups: [{ id: 'next-workspace-group' }], tasks: [] };
  pending.resolve({ groups: [{ id: 'stale-personal-group' }], tasks: [] });
  await refresh;
  assert.deepEqual(harness.state.collaborationOverview.groups.map((group) => group.id), ['next-workspace-group']);
  assert.equal(harness.renderCount(), 0, 'a late overview response must not render after switching Workspaces');
}

{
  const nextDetail = {
    group: { id: 'group-1', title: 'Existing group' },
    messages: [{ id: 'new-message', content: 'New message' }],
    members: [],
    tasks: [],
  };
  const harness = createHarness({ collaborationGroup: async () => nextDetail });
  await harness.controller.refreshCollaborationGroupDetail('group-1');
  assert.equal(harness.state.collaborationGroupId, 'group-1');
  assert.equal(harness.state.collaborationGroupDetail, nextDetail);
  assert.equal(harness.state.collaborationGroupDetail.messages[0].content, 'New message');
  assert.equal(harness.renderCount(), 1);
}

{
  const harness = createHarness({ collaborationGroup: async () => { throw new Error('temporary relay failure'); } });
  const previousDetail = harness.state.collaborationGroupDetail;
  await harness.controller.refreshCollaborationGroupDetail('group-1');
  assert.equal(harness.state.collaborationGroupId, 'group-1');
  assert.equal(harness.state.collaborationGroupDetail, previousDetail, 'a failed background refresh must retain visible messages');
  assert.equal(harness.renderCount(), 1);
}

{
  const pending = deferred();
  const harness = createHarness({ collaborationGroup: async () => pending.promise });
  const refresh = harness.controller.refreshCollaborationGroupDetail('group-1');
  const group2Detail = {
    group: { id: 'group-2', title: 'Second group' },
    messages: [{ id: 'group-2-message', content: 'Do not overwrite me' }],
    members: [],
    tasks: [],
  };
  harness.state.collaborationGroupId = 'group-2';
  harness.state.collaborationGroupDetail = group2Detail;
  pending.resolve({
    group: { id: 'group-1', title: 'First group' },
    messages: [{ id: 'late-message', content: 'Late response' }],
    members: [],
    tasks: [],
  });
  await refresh;
  assert.equal(harness.state.collaborationGroupId, 'group-2');
  assert.equal(harness.state.collaborationGroupDetail, group2Detail, 'a late response must not overwrite the newly selected group');
  assert.equal(harness.renderCount(), 0);
}

{
  const group1 = deferred();
  const group2 = deferred();
  const harness = createHarness({
    collaborationGroup: async ({ groupId }) => (groupId === 'group-1' ? group1.promise : group2.promise),
  });
  const open1 = harness.controller.openCollaborationGroup('group-1');
  const open2 = harness.controller.openCollaborationGroup('group-2');
  group1.resolve({ group: { id: 'group-1' }, messages: [{ content: 'stale open' }], members: [], tasks: [] });
  await open1;
  group2.resolve({ group: { id: 'group-2' }, messages: [{ content: 'current open' }], members: [], tasks: [] });
  await open2;
  assert.equal(harness.state.collaborationGroupId, 'group-2');
  assert.equal(harness.state.collaborationGroupDetail.group.id, 'group-2');
  assert.equal(harness.state.collaborationGroupDetail.messages[0].content, 'current open');
  assert.equal(harness.state.networkConversationBusy, false);
}

{
  const mutation = deferred();
  const reconciliation = deferred();
  let mutationCalls = 0;
  const submitted = { id: 'task-accept-once', status: 'submitted' };
  const accepted = { ...submitted, status: 'result_accepted' };
  const harness = createHarness({
    collaborationTaskAction: async () => {
      mutationCalls += 1;
      return mutation.promise;
    },
    collaborationOverview: async () => reconciliation.promise,
  });
  harness.state.agentDelegations = [submitted];
  harness.state.collaborationOverview = { groups: [], tasks: [submitted] };
  harness.state.collaborationGroupDetail = { ...harness.state.collaborationGroupDetail, tasks: [submitted] };
  const first = harness.controller.handleCollaborationTaskAction(submitted.id, 'accept_result');
  const repeated = harness.controller.handleCollaborationTaskAction(submitted.id, 'accept_result');
  assert.equal(mutationCalls, 1, 'a pending task action must ignore repeated clicks');
  assert.equal(harness.state.collaborationTaskActionBusyById[submitted.id], 'accept_result');
  mutation.resolve({ ok: true, delegation: accepted });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state.agentDelegations[0].status, 'result_accepted', 'the successful mutation must update visible state before reconciliation');
  assert.equal(harness.state.collaborationTaskActionBusyById[submitted.id], undefined);
  assert.deepEqual(harness.notifications.at(-1), { message: '已确认任务结束。', tone: 'success' });
  reconciliation.resolve({ groups: [], tasks: [accepted] });
  await Promise.all([first, repeated]);
}

{
  const submitted = { id: 'task-old-server', status: 'submitted' };
  const accepted = { ...submitted, status: 'result_accepted' };
  const harness = createHarness({
    collaborationTaskAction: async () => { throw new Error('当前状态 result_accepted 不能执行 accept_result。'); },
    collaborationOverview: async () => ({ groups: [], tasks: [accepted] }),
  });
  harness.state.agentDelegations = [submitted];
  harness.state.collaborationOverview = { groups: [], tasks: [submitted] };
  await harness.controller.handleCollaborationTaskAction(submitted.id, 'accept_result');
  assert.equal(harness.state.agentDelegations[0].status, 'result_accepted');
  assert.equal(harness.notifications.some((item) => item.tone === 'error'), false, 'an authoritative accepted state must not be reported as a mutation failure');
  assert.deepEqual(harness.notifications.at(-1), { message: '任务已经确认结束。', tone: 'success' });
}

{
  const submitted = { id: 'task-real-failure', status: 'submitted' };
  const harness = createHarness({
    collaborationTaskAction: async () => { throw new Error('network unavailable'); },
    collaborationOverview: async () => ({ groups: [], tasks: [submitted] }),
  });
  harness.state.agentDelegations = [submitted];
  harness.state.collaborationOverview = { groups: [], tasks: [submitted] };
  await harness.controller.handleCollaborationTaskAction(submitted.id, 'accept_result');
  assert.equal(harness.state.collaborationTaskActionBusyById[submitted.id], undefined, 'a failed mutation must release the task action lock');
  assert.deepEqual(harness.notifications.at(-1), { message: '更新任务失败：network unavailable', tone: 'error' });
}

console.log('collaboration group refresh smoke passed');
