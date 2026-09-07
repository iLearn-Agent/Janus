import assert from 'node:assert/strict';

import { createChatRunController } from '../src/renderer/app/features/chat/chatRunController.js';
import { resolveCurrentChatRun } from '../src/renderer/app/features/navigation/sessionNavigationController.js';

const run = {
  channelId: 'ubuddy-channel',
  sessionId: 'secretary-session',
  displaySessionId: 'secretary-session',
  executionSessionId: 'secretary-session',
  chatKey: 'session:secretary-session',
  departmentId: 'secretary_department',
  agentId: 'secretary_agent',
  statusMessageId: 'ubuddy-status',
  processMessageId: '',
  draftMessageId: '',
  assistantMessageId: '',
  assistantContent: '',
  draftContent: '',
  processEvents: [],
  startedAt: Date.now() - 3000,
  lastStatusStage: 'queued',
  lastStatusText: '',
};
const state = {
  sessions: [], messages: [], chatRuns: [run], activeChatRun: run,
  currentSessionId: 'secretary-session', currentChatKey: 'session:secretary-session', currentTab: 'chat',
  agentDeliveryRunsBySession: {}, imageModel: 'gpt-image-2',
};
const allChatRuns = () => state.chatRuns;
const chatRunForChannel = (channelId) => state.chatRuns.find((item) => item.channelId === channelId) || null;
const syncCurrentChatRun = () => {
  state.activeChatRun = state.chatRuns.find((item) => !item.nonBlocking && (item.displaySessionId || item.sessionId) === state.currentSessionId) || null;
  return state.activeChatRun;
};
let copiedFilePath = '';
let openedFilePayload = null;
const controller = createChatRunController({
  api: {}, windowRef: { confirm: () => true }, documentRef: {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  state, render: () => {}, notify: () => {}, userVisibleErrorMessage: (error) => String(error?.message || error),
  chatRunForChannel, syncCurrentChatRun, upsertRecentSession: () => {}, expandProject: () => {},
  agentNameById: (id) => id, departmentName: (id) => id, allChatRuns, currentChatRun: () => state.activeChatRun,
  captureMessageScrollState: () => null, restoreMessageScrollState: () => {}, renderMessageList: () => '',
  parsePreviewPayload: (value) => ({ encoded: value }), previewFileInfo: () => {}, saveFileFromPayload: () => {}, showFileFromPayload: () => {},
  openFileFromPayload: (payload) => { openedFilePayload = payload; }, copyFilePath: (value) => { copiedFilePath = value; },
  copyMessageText: () => {}, editMessageFromHistory: () => {}, pathBasename: (value) => value,
  projectForSession: () => null, activeProject: () => null, scrollMessagesToBottom: () => {}, imageModelOptions: [],
  runStatusRefreshMs: 1000, runUpdateThrottleMs: 0, setTimer: (callback) => { callback(); return 1; },
  setRepeatingTimer: () => 1, clearRepeatingTimer: () => {},
});

controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'start', sessionId: 'worker-session', displaySessionId: 'secretary-session', executionSessionId: 'worker-session',
  departmentId: 'general', agentId: 'general_agent',
});
assert.equal(run.displaySessionId, 'secretary-session');
assert.equal(run.sessionId, 'secretary-session');
assert.equal(run.executionSessionId, 'worker-session');
assert.equal(controller.isRunForCurrentChat(run), true);

controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'activity', activityId: 'command-stream', activityType: 'command', status: 'running',
  title: '正在执行命令', command: 'rg -n processEvents src', cwd: '~/Janus-main', output: 'first line\n',
});
controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'activity', activityId: 'command-stream', activityType: 'command', status: 'completed',
  title: '命令执行', output: 'first line\nsecond line\n', exitCode: 0, durationMs: 125,
});
const commandEvent = run.processEvents.find((item) => item.activityId === 'command-stream');
assert.equal(commandEvent.command, 'rg -n processEvents src');
assert.equal(commandEvent.cwd, '~/Janus-main');
assert.equal(commandEvent.output, 'first line\nsecond line\n');
assert.equal(commandEvent.status, 'completed');
assert.equal(commandEvent.exitCode, 0);
assert.equal(commandEvent.durationMs, 125);
for (let index = 0; index < 205; index += 1) {
  controller.handleChatRunEvent('ubuddy-channel', {
    kind: 'activity', activityId: 'long-native-stream', activityType: 'reasoning', status: 'running',
    title: '思考摘要', reasoningText: `detail-${index}\n`, appendReasoningText: true,
    protocolEvents: [{
      sequence: index + 1,
      method: 'item/reasoning/textDelta',
      params: { itemId: 'long-native-stream', delta: `detail-${index}\n` },
    }],
  });
}
const longNativeStream = run.processEvents.find((item) => item.activityId === 'long-native-stream');
assert.equal(longNativeStream.protocolEvents.length, 200,
  'live renderer merging must retain a bounded recent protocol history for long streams');
assert.equal(longNativeStream.protocolEvents[0].params.delta, 'detail-5\n');
assert.equal(longNativeStream.protocolEvents.at(-1).params.delta, 'detail-204\n');
controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'activity', activityId: 'cross-turn-native-stream', activityType: 'goal', status: 'running',
  protocolEvents: [{
    protocolEventId: 'turn-one:1', sequence: 1, receivedAtMs: 1000,
    method: 'thread/goal/updated', params: { turnId: 'turn-one' },
  }],
});
controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'activity', activityId: 'cross-turn-native-stream', activityType: 'goal', status: 'running',
  protocolEvents: [{
    protocolEventId: 'turn-two:1', sequence: 1, receivedAtMs: 2000,
    method: 'thread/goal/updated', params: { turnId: 'turn-two' },
  }],
});
const crossTurnNativeStream = run.processEvents.find((item) => item.activityId === 'cross-turn-native-stream');
assert.equal(crossTurnNativeStream.protocolEvents.length, 2,
  'protocol events from separate app-server turns must not collide when sequence numbers restart');
assert.equal(crossTurnNativeStream.protocolEvents[1].params.turnId, 'turn-two');
let processToggleHandler = null;
const commandDetails = {
  dataset: { processItemToggle: `${run.processMessageId}::command-stream` },
  open: true,
  addEventListener: (name, handler) => { if (name === 'toggle') processToggleHandler = handler; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-process-item-toggle]' ? [commandDetails] : [],
});
processToggleHandler();
assert.equal(commandEvent.expanded, true);
assert.equal(commandEvent.expansionLocked, true);
controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'activity', activityId: 'command-stream', activityType: 'command', status: 'completed', output: 'updated output\n',
});
assert.equal(run.processEvents.find((item) => item.activityId === 'command-stream').expanded, true,
  'command expansion must survive subsequent streamed updates');
let expandAllHandler = null;
let collapseAllHandler = null;
const expandAllButton = {
  dataset: { processExpandAll: run.processMessageId },
  addEventListener: (name, handler) => { if (name === 'click') expandAllHandler = handler; },
};
const collapseAllButton = {
  dataset: { processCollapseAll: run.processMessageId },
  addEventListener: (name, handler) => { if (name === 'click') collapseAllHandler = handler; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => ({
    '[data-process-expand-all]': [expandAllButton],
    '[data-process-collapse-all]': [collapseAllButton],
  })[selector] || [],
});
const bulkToggleEvent = { preventDefault: () => {}, stopPropagation: () => {} };
expandAllHandler(bulkToggleEvent);
assert.equal(run.processEvents.find((item) => item.activityId === 'command-stream').expanded, true);
assert.equal(run.processHistoryExpanded, true);
collapseAllHandler(bulkToggleEvent);
assert.equal(run.processEvents.find((item) => item.activityId === 'command-stream').expanded, false);
assert.equal(run.processHistoryExpanded, false);

state.currentSessionId = 'worker-session';
assert.equal(controller.isRunForCurrentChat(run), false, 'a blocking uBuddy run must remain owned by the uBuddy display session');
state.currentSessionId = 'secretary-session';

state.currentSessionId = '';
state.currentChatKey = 'session:secretary-session';
state.collaborationGroupId = 'work-group-current';
assert.equal(controller.isRunForCurrentChat(run), false,
  'an active uBuddy run must not reclaim a work-group conversation through a stale chat key');
controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'start', displaySessionId: 'secretary-session-rebound', executionSessionId: 'worker-session-rebound',
});
assert.equal(state.currentSessionId, '', 'uBuddy events must not replace the current work-group surface');
state.collaborationGroupId = '';
state.currentSessionId = 'secretary-session';
state.currentChatKey = 'session:secretary-session';

controller.restorePersistentDeliveryRuns([{
  workId: 'delivery-work', sourceSessionId: 'secretary-session', targetSessionId: 'worker-session', deliveryStatus: 'running',
  metadata: { targetAgentId: 'general_agent', targetAgentName: 'General Agent', startedAt: new Date(Date.now() - 5000).toISOString() },
  events: [{ sequenceNo: 1, kind: 'progress', stage: 'working', message: '通用 Agent 正在执行', payload: { agentId: 'general_agent', departmentId: 'general' } }],
}], 'secretary-session');
const deliveryRun = state.chatRuns.find((item) => item.workId === 'delivery-work');
assert.ok(deliveryRun?.nonBlocking);
assert.equal(controller.isRunForCurrentChat(deliveryRun), true);
state.currentSessionId = 'worker-session';
assert.equal(controller.isRunForCurrentChat(deliveryRun), true, 'a durable delivery run must be visible from the worker session too');

const agentRun = {
  ...run,
  channelId: 'agent-stream-channel',
  sessionId: 'agent-session-old',
  displaySessionId: 'agent-session-old',
  executionSessionId: 'agent-session-new',
  chatKey: 'agent:general-instance',
  departmentId: 'general',
  agentId: 'general_agent',
};
state.collaborationGroupId = '';
state.currentSessionId = 'agent-session-new';
state.currentChatKey = 'agent:general-instance';
assert.equal(controller.isRunForCurrentChat(agentRun), true,
  'an Agent single-window stream must remain visible when its canonical session changes during execution');
state.currentChatKey = 'agent:other-instance';
assert.equal(controller.isRunForCurrentChat(agentRun), false,
  'an Agent stream must not render in a different Agent single-window conversation');

const agentRunB = {
  ...agentRun,
  channelId: 'agent-stream-channel-b',
  sessionId: 'agent-session-b',
  displaySessionId: 'agent-session-b',
  executionSessionId: 'agent-session-b',
  chatKey: 'agent:general-instance-b',
  agentInstanceId: 'general-instance-b',
};
state.chatRuns = [agentRun, agentRunB];
state.currentSessionId = 'agent-session-old';
state.currentChatKey = 'agent:general-instance-b';
assert.equal(resolveCurrentChatRun({ state, allChatRuns, chatRunForSession: (sessionId) => (
  state.chatRuns.find((item) => !item.nonBlocking && (item.displaySessionId || item.sessionId) === sessionId) || null
) }), agentRunB,
'the active Agent chat key must isolate same-department employee runs even while another employee session is active');
state.chatRuns = [run, deliveryRun];

state.currentSessionId = 'secretary-session';
state.currentChatKey = 'session:secretary-session';
controller.handleChatRunEvent('ubuddy-channel', {
  kind: 'cancelled', message: '用户已停止本次处理。',
});
assert.ok(run.processEvents.some((item) => item.activityId === 'command-stream'), 'cancellation must retain earlier command records');
assert.equal(run.processEvents.at(-1)?.activityType, 'status');
assert.equal(run.processEvents.at(-1)?.status, 'cancelled');
const interruptedProcess = state.messages.find((message) => message.id === run.processMessageId);
assert.equal(interruptedProcess?.metadata?.streaming, false);
assert.equal(interruptedProcess?.metadata?.expanded, true);
assert.ok(interruptedProcess?.metadata?.processEvents?.some((item) => item.activityId === 'command-stream'));
controller.clearRunTransientMessages(run);
assert.equal(interruptedProcess?.metadata?.expanded, true,
  'terminal cleanup must not collapse an interrupted process flow');
assert.equal(state.messages.some((message) => message.metadata?.cancelled && message.content === '用户已停止本次处理。'), false,
  'cancellation status must live inside the process flow instead of replacing it with a standalone answer');

let historyMoreHandler = null;
const historyMoreButton = {
  dataset: { processHistoryMore: run.processMessageId, processHistoryStep: '20' },
  addEventListener: (name, handler) => { if (name === 'click') historyMoreHandler = handler; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => selector === '[data-process-history-more]' ? [historyMoreButton] : [],
});
historyMoreHandler({ preventDefault: () => {}, stopPropagation: () => {} });
assert.equal(interruptedProcess?.metadata?.historyVisibleCount, 40,
  'loading older process history must increase the mounted history window');

const failedRun = {
  ...run,
  channelId: 'failed-channel',
  processMessageId: '',
  statusMessageId: '',
  assistantMessageId: '',
  assistantContent: '',
  processEvents: [],
  terminal: false,
  failed: false,
  startedAt: Date.now() - 1000,
};
state.chatRuns.push(failedRun);
state.activeChatRun = failedRun;
controller.handleChatRunEvent('failed-channel', {
  kind: 'activity', activityId: 'reason-before-failure', activityType: 'reasoning', status: 'running',
  title: '思考摘要', detail: '被动中断前的处理记录。',
});
controller.handleChatRunEvent('failed-channel', { kind: 'error', message: 'Codex process exited unexpectedly.' });
assert.ok(failedRun.processEvents.some((item) => item.activityId === 'reason-before-failure'),
  'passive failures must retain earlier process records');
assert.equal(failedRun.processEvents.at(-1)?.status, 'failed');
const failedProcess = state.messages.find((message) => message.id === failedRun.processMessageId);
assert.equal(failedProcess?.metadata?.streaming, false);
assert.equal(failedProcess?.metadata?.expanded, true);
assert.ok(failedProcess?.metadata?.processEvents?.some((item) => item.activityId === 'reason-before-failure'));

const orderedRun = {
  ...run,
  channelId: 'ordered-channel',
  departmentId: 'secretary_department',
  agentId: 'secretary_agent',
  processMessageId: '',
  statusMessageId: '',
  assistantMessageId: '',
  assistantContent: '',
  processEvents: [],
  terminal: false,
  failed: false,
  cancelled: false,
  startedAt: Date.now() - 500,
};
state.chatRuns.push(orderedRun);
state.activeChatRun = orderedRun;
controller.handleChatRunEvent('ordered-channel', {
  kind: 'activity', activityId: 'native-commentary', activityType: 'commentary', eventOrigin: 'codex',
  nativeSource: 'codex_app_server', status: 'completed', detail: 'Native commentary must remain above later process updates.',
});
assert.ok(orderedRun.processEvents.some((event) => event.activityId === 'native-commentary' && event.detail.includes('Native commentary')),
  'native commentary must be projected into the process transcript');
controller.handleChatRunEvent('ordered-channel', { kind: 'answer', content: '先到达的回答片段。' });
controller.handleChatRunEvent('ordered-channel', {
  kind: 'activity', activityId: 'late-process', activityType: 'command', status: 'completed',
  title: '命令执行', command: 'verify context', output: 'ok', exitCode: 0,
});
const orderedProcessIndex = state.messages.findIndex((message) => message.id === orderedRun.processMessageId);
const orderedAnswerIndex = state.messages.findIndex((message) => message.id === orderedRun.assistantMessageId);
const orderedMessageOrder = state.messages.map((message, index) => ({ index, id: message.id, transient: message.metadata?.transient || '' }));
assert.ok(orderedProcessIndex >= 0 && orderedProcessIndex < orderedAnswerIndex,
  'native commentary and late process events must remain in one processed transcript ahead of the final answer: ' + JSON.stringify(orderedMessageOrder));
assert.equal(state.messages[orderedProcessIndex]?.metadata?.streaming, false,
  'late native events must not reopen the process transcript after final-answer streaming begins');
controller.handleChatRunEvent('ordered-channel', { kind: 'answer', content: '最终回答。', streaming: false });
controller.handleChatRunEvent('ordered-channel', { kind: 'done', answer: '最终回答。' });
assert.equal(state.messages.find((message) => message.id === orderedRun.processMessageId)?.metadata?.streaming, false);
assert.equal(state.messages.find((message) => message.id === orderedRun.assistantMessageId)?.metadata?.streaming, false);

let copyPathHandler = null;
let openPathHandler = null;
const copyPathButton = {
  dataset: { copyFilePath: 'docs/specification.docx' },
  hasAttribute: (name) => name === 'data-codex-file-action',
  addEventListener: (name, handler) => { if (name === 'click') copyPathHandler = handler; },
};
const openPathButton = {
  dataset: { openFile: '%7B%22path%22%3A%22specification.docx%22%7D' },
  hasAttribute: (name) => name === 'data-codex-file-action',
  addEventListener: (name, handler) => { if (name === 'click') openPathHandler = handler; },
};
controller.wireMessageEvents({
  querySelectorAll: (selector) => {
    if (selector === '[data-copy-file-path]') return [copyPathButton];
    if (selector === '[data-open-file]') return [openPathButton];
    return [];
  },
});
const actionEventState = { prevented: 0, stopped: 0 };
const actionEvent = {
  preventDefault: () => { actionEventState.prevented += 1; },
  stopPropagation: () => { actionEventState.stopped += 1; },
};
copyPathHandler(actionEvent);
openPathHandler(actionEvent);
assert.equal(copiedFilePath, 'docs/specification.docx');
assert.deepEqual(openedFilePayload, { encoded: '%7B%22path%22%3A%22specification.docx%22%7D' });
assert.deepEqual(actionEventState, { prevented: 2, stopped: 2 },
  'clicking file actions inside a details summary must not toggle the diff card');

process.stdout.write('Chat run display/execution session isolation smoke passed.\n');
