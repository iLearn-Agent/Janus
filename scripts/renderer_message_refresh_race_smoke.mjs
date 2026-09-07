import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createLatestRequestCoordinator } from '../src/renderer/app/features/chat/latestRequestCoordinator.js';
import { agentConversationCompletionKeys, createMessageSendController } from '../src/renderer/app/features/chat/messageSendController.js';

const coordinator = createLatestRequestCoordinator();
const sessionId = 'session-race';
const olderRequest = coordinator.begin(sessionId);
const newerRequest = coordinator.begin(sessionId);

assert.equal(coordinator.isLatest(sessionId, newerRequest), true, 'the newest message refresh must be accepted');
assert.equal(coordinator.isLatest(sessionId, olderRequest), false, 'an older message refresh must be rejected after a newer refresh starts');

const otherSessionRequest = coordinator.begin('other-session');
assert.equal(coordinator.isLatest('other-session', otherSessionRequest), true, 'request ordering must remain isolated per session');
assert.equal(coordinator.isLatest(sessionId, newerRequest), true, 'refreshing another session must not invalidate the active session');

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const messageSendSource = readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8');
assert.match(mainSource, /onSessionUpdated:[\s\S]*sendWebContentsSafely\(window, 'chat-session:updated', payload\)/,
  'Feishu Session updates must be broadcast to Electron windows');
assert.match(preloadSource, /onChatSessionUpdated:[\s\S]*ipcRenderer\.on\('chat-session:updated', listener\)[\s\S]*removeListener\('chat-session:updated', listener\)/,
  'the preload bridge must expose a removable external Session update subscription');
assert.match(rendererSource, /messagePageRequestCoordinator\.begin\(cleanSessionId\)/, 'message page loads must receive a request version');
assert.match(rendererSource, /messagePageRequestCoordinator\.isLatest\(cleanSessionId, page\.rendererMessagePageRequestVersion\)/, 'message page application must reject stale request versions');
assert.match(rendererSource, /onChatSessionUpdated[\s\S]*refreshExternallyUpdatedSession/, 'external-channel Session updates must trigger a persisted message refresh');
assert.match(rendererSource, /function refreshExternallyUpdatedSession[\s\S]*payloadUserId !== currentUserId[\s\S]*payloadWorkspaceId !== currentWorkspaceId/,
  'external Session refreshes must remain scoped to the active user and Workspace');
assert.match(rendererSource, /function refreshExternallyUpdatedSession[\s\S]*loadLatestRendererMessagePage\(messageSessionId\)[\s\S]*workspaceGeneration !== state\.workspaceSwitchGeneration[\s\S]*applyLatestRendererMessagePage/,
  'external Session refreshes must use coordinated message loading and re-check Workspace state before applying');
assert.match(rendererSource, /state\.messagePagination\?\.source === 'agent'[\s\S]*agentConversationTimeline/, 'background refreshes must preserve aggregated Agent timelines');
assert.match(rendererSource, /function refreshExternallyUpdatedSession[\s\S]*payload\.agentInstanceId[\s\S]*refreshesActiveAgent[\s\S]*loadLatestRendererMessagePage\(messageSessionId\)/,
  'external Agent updates must refresh the active aggregated timeline even when its visible Session differs');
assert.match(rendererSource, /taskChatUpdated[\s\S]*\(taskChatVisible \|\| employeeWorkVisible\) && !taskChatUpdated/, 'task events already patched into chat must not trigger a duplicate full render');
assert.match(rendererSource, /rememberMessageViewState\(messageScrollSnapshot\)/, 'renderer rerenders must retain the current conversation anchor');
assert.match(rendererSource, /function restoreMessageViewState[\s\S]*restoreMessageScrollState\(snapshot\)/, 'returning to a conversation must restore its saved message position');
const scrollFinishSource = rendererSource.slice(
  rendererSource.indexOf('function finishMessageScrollInteraction()'),
  rendererSource.indexOf('function deferMessageScrollInteractionFinish()'),
);
assert.ok(scrollFinishSource.indexOf('const interactionActive = messageScrollInteracting;') >= 0,
  'scroll completion must retain the active-interaction state until follow-bottom is evaluated');
assert.ok(scrollFinishSource.lastIndexOf('messageScrollInteracting = false;') > scrollFinishSource.indexOf('const distanceFromBottom'),
  'a live task rerender must not observe scrolling as finished before the final position is evaluated');
assert.match(rendererSource, /function render\(options = \{\}\) \{\s*if \(messageScrollInteracting\) \{\s*messageScrollRenderPending = true;/,
  'full message-list replacement must be deferred while the user is scrolling');
assert.match(rendererSource, /function flushPendingMessageScrollRender\(\)[\s\S]*requestAnimationFrame\(\(\) => render\(\)\)/,
  'a deferred message render must resume after the scroll interaction settles');
assert.match(rendererSource, /let messageScrollPointerActive = false;[\s\S]*function finishMessagePointerInteraction\(\) \{\s*messageScrollPointerActive = false;\s*finishMessageScrollInteraction\(\);/,
  'holding a scrollbar or touch gesture must remain an explicit interaction until release');
assert.match(rendererSource, /messageScrollIdleTimer = setTimeout\([\s\S]*if \(messageScrollPointerActive\) return;[\s\S]*finishMessageScrollInteraction\(\)/,
  'the idle timer must not end a scrollbar drag while the pointer remains down');
assert.match(rendererSource, /querySelectorAll\(':scope > \[data-message-id\]'\)\]\s*\.filter\(\(item\) => !String\(item\.dataset\.messageId \|\| ''\)\.startsWith\('history-loader:'\)\)/,
  'message anchoring must use a real visible message instead of the pagination control');
assert.match(rendererSource, /let taskWorkspaceScrollInteracting = false;[\s\S]*function beginTaskWorkspaceScrollInteraction\(\)[\s\S]*taskWorkspaceScrollInteracting = true;[\s\S]*function finishTaskWorkspaceScrollInteraction\(\)/,
  'task workspace updates must retain an explicit scrollbar-drag interaction lock');
assert.match(rendererSource, /function scheduleTaskWorkspaceRender\(\)[\s\S]*if \(taskWorkspaceRenderTimer \|\| taskWorkspaceScrollInteracting\) return;/,
  'task workspace rerenders must remain deferred for the full scrollbar drag');
assert.match(rendererSource, /function render\(options = \{\}\)[\s\S]*if \(taskWorkspaceScrollInteracting && state\.activeTaskWorkspaceKind === 'task_run'\) \{\s*taskWorkspaceRenderPending = true;/,
  'unrelated renderer updates must not replace the task workspace during a scrollbar drag');
const loadOlderSource = rendererSource.slice(
  rendererSource.indexOf('async function loadOlderMessages()'),
  rendererSource.indexOf('function projectForSession', rendererSource.indexOf('async function loadOlderMessages()')),
);
assert.doesNotMatch(loadOlderSource, /previousScrollHeight|nextMessageList\.scrollTop/,
  'history pagination must not apply a second height-delta correction after anchor restoration');
assert.match(rendererSource, /function patchUBuddyTaskDisplay[\s\S]*renderUBuddyTaskStrip\(\)/, 'uBuddy task updates must patch the task strip independently');
assert.match(rendererSource, /function applyLatestRendererMessagePage[\s\S]*state\.messages = Array\.isArray\(page\.items\)[\s\S]*syncCurrentChatRun\(\);[\s\S]*restoreActiveRunTransient\(\);/,
  'persisted message refreshes must restore the active transient run before rendering');
assert.match(rendererSource, /function reactivateAgentConversation[\s\S]*saveCompletedConversationKeys\(/,
  'new Agent activity must persistently restore completed conversations to the main list');
assert.match(messageSendSource, /registerChatRun\(run\);[\s\S]*reactivateAgentConversation\(/,
  'an Agent conversation must be reactivated before the first in-progress render');
assert.match(messageSendSource, /Promise\.allSettled\(\[/,
  'message detail and Session-list completion refreshes must settle independently');
assert.match(messageSendSource, /upsertRecentSession\(result\.session\)/,
  'the returned Session must be inserted before best-effort completion refreshes finish');
assert.deepEqual(agentConversationCompletionKeys({
  sessionId: ' session-reactivated ',
  agentId: 'ppt',
  agentInstanceId: 'ppt-instance-a',
}), ['agent:session-reactivated', 'agent-pending:ppt:ppt-instance-a']);
assert.deepEqual(agentConversationCompletionKeys({ agentId: 'ppt' }), ['agent-pending:ppt']);

const networkWorkspaceSource = readFileSync(new URL('../src/renderer/app/features/network/workspaceController.js', import.meta.url), 'utf8');
assert.match(networkWorkspaceSource, /const shouldFollowBottom = networkConversationShouldFollowBottom\(\);[\s\S]*if \(shouldFollowBottom\) scrollNetworkConversationToBottom\(\)/,
  'a delayed network reply must not force the conversation to the bottom after the user scrolls away');
assert.match(networkWorkspaceSource, /const shouldFollowBottom = delegationWorkspaceShouldFollowBottom\(\);[\s\S]*if \(shouldFollowBottom\) scrollDelegationWorkspaceToBottom\(\)/,
  'a delayed delegation update must preserve explicit user scroll position');
assert.match(networkWorkspaceSource, /const applyMessagePage =[\s\S]*state\.messages = Array\.isArray\(page\.items\)[\s\S]*restoreActiveRunTransient\?\.\(\);/,
  'uBuddy workspace message refreshes must restore active transient runs');
assert.match(networkWorkspaceSource, /sourceMessagesRefresh\.then[\s\S]*state\.messages = Array\.isArray\(messagesResult\.value\?\.items\)[\s\S]*restoreActiveRunTransient\?\.\(\);/,
  'returning from a task workspace must not let a late message refresh erase the active uBuddy status');

const chatControllerSource = readFileSync(new URL('../src/renderer/app/features/chat/chatRunController.js', import.meta.url), 'utf8');
assert.match(chatControllerSource, /querySelectorAll\('\.codex-change-hover-diff'\)[\s\S]*addEventListener\('wheel', \(event\) => event\.stopPropagation\(\)\)/, 'hover preview wheel events must not reach the conversation scroll handler');

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};
const pageStarted = deferred();
const pageResult = deferred();
let secretaryChatResult = { session: { id: 'session-a', departmentId: 'secretary_department' }, message: { id: 'answer-a' } };
let sendChatImpl = async () => { throw new Error('unexpected Agent send'); };
let listMessagePageImpl = async () => {
  pageStarted.resolve();
  return pageResult.promise;
};
let listSessionsImpl = async () => localState.sessions;
const activeRuns = [];
const reactivatedAgentConversations = [];
let renderCount = 0;
let scrollCount = 0;
const localState = {
  currentUser: { id: 'race-user' },
  activeAccountWorkspace: { id: 'workspace_personal' },
  workspaceSwitchGeneration: 0,
  currentSessionId: 'session-a',
  currentChatKey: 'session:session-a',
  currentTab: 'chat',
  sessions: [{ id: 'session-a', departmentId: 'secretary_department', title: 'Session A' }],
  messages: [],
  attachments: [],
  composerFileReferences: [],
  composerMemoryReferences: [],
  composerMentions: [],
  secretaryMentions: [],
  composerTaskReference: null,
  messageQuote: null,
  homeMode: 'secretary',
  currentDepartmentId: '',
  currentAgentId: '',
  currentAgentInstanceId: '',
  employeeOverview: { roster: [] },
  uBuddyFeatureFlags: {},
  workspaceDetached: false,
  interactionMode: '',
  sandboxPermission: 'request-approval',
  sidebarSectionsOpen: {},
  chatRuns: activeRuns,
  busy: false,
};
const input = { value: 'race request', dataset: {} };
const controller = createMessageSendController({
  api: {
    secretaryChat: async () => secretaryChatResult,
    sendChat: (...args) => sendChatImpl(...args),
    listMessagePage: (...args) => listMessagePageImpl(...args),
    listSessions: (...args) => listSessionsImpl(...args),
    chatContextStatus: async () => null,
  },
  documentRef: { getElementById: (id) => id === 'chat-input' ? input : null },
  state: localState,
  render() { renderCount += 1; },
  notify() {},
  sendCollaborationGroupMessage: async () => {},
  sendChatGroupMessage: async () => {},
  sendDirectSocialMessage: async () => {},
  sendSocialGroupMessage: async () => {},
  currentChatRun: () => null,
  retractNetworkPanelForChat() {},
  resolveSelectedAgentId: (_departmentId, agentId) => agentId,
  projectById: () => null,
  activeProject: () => null,
  pendingAttachmentsForMessage: () => [],
  registerChatRun: (run) => activeRuns.push(run),
  assignmentLabelForRun: () => 'uBuddy',
  updateRunStatusMessage() {},
  scrollMessagesToBottom() { scrollCount += 1; },
  readyAttachmentsForSend: async () => [],
  updateLocalMessageAttachments() {},
  isRunForCurrentChat: (run) => String(run.displaySessionId || run.sessionId || '') === String(localState.currentSessionId || ''),
  currentModelValue: () => '',
  currentReasoningValue: () => 'medium',
  refreshCollaborationOverview: async () => {},
  refreshSocialThreads: async () => {},
  expandProject() {},
  handleChatRunEvent() {},
  userErrorMessage: (error) => String(error?.message || error),
  clearRunTransientMessages() {},
  unregisterChatRun: (run) => {
    const index = activeRuns.indexOf(run);
    if (index >= 0) activeRuns.splice(index, 1);
  },
  allChatRuns: () => activeRuns,
  stopRunStatusTimer() {},
  projectName: () => '',
  workspaceDisplayLabel: () => '',
  currentPptTemplate: () => ({ id: 'none', label: '', path: '' }),
  shortAgentLabel: () => '',
  agentNameById: () => '',
  activeAgentInstanceId: () => '',
  restorePersistentDeliveryRuns() {},
  reactivateAgentConversation(payload = {}) {
    reactivatedAgentConversations.push(payload);
  },
  upsertRecentSession(session = {}) {
    if (!session.id) return;
    localState.sessions = [
      { ...(localState.sessions.find((item) => item.id === session.id) || {}), ...session },
      ...localState.sessions.filter((item) => item.id !== session.id),
    ];
  },
  beginMessagePageRequest: (key) => coordinator.begin(key),
  messagePageRequestIsLatest: (key, version) => coordinator.isLatest(key, version),
});
const sendPromise = controller.sendChat({ preventDefault() {} });
await pageStarted.promise;
const renderCountBeforeSwitch = renderCount;
const scrollCountBeforeSwitch = scrollCount;
localState.currentSessionId = 'session-b';
localState.currentChatKey = 'session:session-b';
localState.activeAccountWorkspace = { id: 'workspace-other' };
localState.workspaceSwitchGeneration += 1;
localState.sessions = [{ id: 'session-b', departmentId: 'general', title: 'Session B' }];
localState.messages = [{ id: 'message-b', role: 'assistant', content: 'Session B remains visible' }];
pageResult.resolve({ items: [{ id: 'message-a', role: 'assistant', content: 'stale Session A result' }], nextCursor: null, hasMore: false });
await sendPromise;
assert.deepEqual(localState.messages.map((message) => message.id), ['message-b'], 'a completed send must re-check the active conversation after message loading finishes');
assert.deepEqual(localState.sessions.map((session) => session.id), ['session-b'], 'a completed send must not replace the active Workspace session list');
assert.equal(renderCount, renderCountBeforeSwitch, 'a background completion must not rebuild the newly selected conversation');
assert.equal(scrollCount, scrollCountBeforeSwitch, 'a background completion must not scroll the newly selected conversation');

localState.activeAccountWorkspace = { id: 'workspace-personal' };
localState.workspaceSwitchGeneration += 1;
localState.currentSessionId = '';
localState.currentChatKey = 'new-refresh-failure';
localState.sessions = [];
localState.messages = [];
localState.homeMode = 'secretary';
input.value = 'refresh failure request';
secretaryChatResult = {
  session: { id: 'session-refresh-recovered', departmentId: 'secretary_department', title: 'Recovered Session' },
  message: { id: 'answer-refresh-recovered' },
};
listMessagePageImpl = async () => { throw new Error('message detail refresh failed'); };
listSessionsImpl = async () => { throw new Error('Session list refresh failed'); };
await controller.sendChat({ preventDefault() {} });
assert.deepEqual(localState.sessions.map((session) => session.id), ['session-refresh-recovered'],
  'the returned Session must remain visible when both best-effort completion refreshes fail');
assert.equal(localState.messages.some((message) => String(message.content || '').includes('执行失败')), false,
  'a post-completion refresh failure must not turn a successful model response into an execution failure');

const agentSendResult = deferred();
const agentSession = {
  id: 'session-agent-reactivated',
  departmentId: 'ppt_department',
  agentId: 'ppt',
  agentInstanceId: 'ppt-instance-a',
  title: 'PPT conversation',
};
localState.currentSessionId = agentSession.id;
localState.currentChatKey = `agent:${agentSession.agentInstanceId}`;
localState.sessions = [agentSession];
localState.messages = [];
localState.homeMode = 'department';
localState.currentDepartmentId = 'ppt_department';
localState.currentAgentId = 'ppt';
localState.currentAgentInstanceId = agentSession.agentInstanceId;
localState.employeeOverview = {
  roster: [{ id: agentSession.agentInstanceId, agentFamilyId: 'ppt', employmentState: 'active', routeEligible: true }],
};
input.value = 'reactivate this Agent';
sendChatImpl = () => agentSendResult.promise;
listMessagePageImpl = async () => ({ items: [{ id: 'agent-answer', role: 'assistant', content: 'done' }], nextCursor: null, hasMore: false });
listSessionsImpl = async () => [agentSession];
const agentSendPromise = controller.sendChat({ preventDefault() {} });
await Promise.resolve();
assert.deepEqual(reactivatedAgentConversations.at(-1), {
  sessionId: agentSession.id,
  agentId: 'ppt',
  agentInstanceId: agentSession.agentInstanceId,
}, 'an existing completed Agent conversation must be reactivated before its response finishes');
agentSendResult.resolve({ session: agentSession, message: { id: 'agent-answer', agentInstanceId: agentSession.agentInstanceId } });
await agentSendPromise;

process.stdout.write('Renderer message refresh race smoke passed.\n');
