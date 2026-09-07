import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';

Object.assign(state, {
  currentUser: { id: 'message-mode-renderer-user', displayName: 'Mode User' },
  languageMode: 'zh-CN',
  currentTab: 'chat',
  currentSessionId: 'message-mode-renderer-session',
  currentChatKey: 'session:message-mode-renderer-session',
  currentDepartmentId: '',
  currentAgentId: '',
  homeMode: 'secretary',
  sessions: [{
    id: 'message-mode-renderer-session', title: 'uBuddy', departmentId: 'secretary_department',
    agentId: 'secretary_agent', status: 'active', writeState: 'writable',
  }],
  messages: [],
  attachments: [],
  composerMentions: [],
  secretaryMentions: [],
  chatDraft: '保留这份草稿',
  activeChatRun: null,
  chatRuns: [],
  busy: false,
  networkPanelOpen: false,
  networkConversationPeerId: '',
  networkConversationGroupId: '',
  chatGroupId: '',
  collaborationGroupId: '',
  uBuddyFeatureFlags: { ...(state.uBuddyFeatureFlags || {}), messageModeV1: true, structuredTaskReference: true },
  uBuddyMessageMode: 'task',
  uBuddyMessageModeMenuOpen: true,
  uBuddyParticipantSelectionPolicy: 'all_mentioned',
});

const uBuddySession = state.sessions[0];
state.currentSessionId = '';
state.currentChatKey = 'home:secretary';
state.sessions = [];
const ordinarySecretaryHomeMarkup = renderChat();
assert.doesNotMatch(ordinarySecretaryHomeMarkup, /data-ubuddy-message-mode-toggle|data-ubuddy-participant-policy-toggle/,
  'a bare secretary home mode must not expose controls reserved for the real uBuddy private conversation');
state.sessions = [uBuddySession];
state.currentSessionId = uBuddySession.id;
state.currentChatKey = `session:${uBuddySession.id}`;

const taskMarkup = renderChat();
assert.match(taskMarkup, /class="ubuddy-message-mode-picker is-open"/);
assert.match(taskMarkup, /data-ubuddy-message-mode-toggle[^>]*>[^]*<span>任务<\/span>/);
assert.match(taskMarkup, /data-ubuddy-message-mode="task"[^>]*class="is-active"|class="is-active"[^>]*data-ubuddy-message-mode="task"/);
assert.doesNotMatch(taskMarkup, /class="task-reference-trigger"/, 'the standalone task-reference button should be removed');
assert.match(taskMarkup, /告诉 uBuddy 你想完成什么任务/);
assert.match(taskMarkup, />保留这份草稿<\/textarea>/);
assert.match(taskMarkup, /data-social-mention-toggle[^>]*>@<\/button>/,
  'the uBuddy mention trigger must use the compact global @ label');
assert.doesNotMatch(taskMarkup, /data-ubuddy-participant-policy/,
  'participant policy must stay hidden until at least two task recipients are selected');

state.composerMentions = [{
  principalType: 'user', userId: 'user-09', mentionId: 'mention-09', displayText: '@09', source: 'picker',
}];
state.secretaryMentions = [{
  principalType: 'user', userId: 'user-05', mentionId: 'mention-05', displayText: '@05', source: 'picker',
}];
state.chatDraft = '@09 @05 请共同完成研究任务';
const allParticipantsMarkup = renderChat();
assert.match(allParticipantsMarkup, /data-ubuddy-participant-policy-toggle[^>]*>[\s\S]*<span>全部参与<\/span>/,
  'multi-recipient task mode must show the current participant policy in one compact trigger');
assert.doesNotMatch(allParticipantsMarkup, /data-ubuddy-participant-policy="all_mentioned"/,
  'participant choices must stay collapsed until the trigger is clicked');

state.uBuddyParticipantSelectionMenuOpen = true;
const openParticipantsMarkup = renderChat();
assert.match(openParticipantsMarkup, /ubuddy-participant-policy-picker is-open/);
assert.match(openParticipantsMarkup, /aria-checked="true"[^>]*data-ubuddy-participant-policy="all_mentioned"|data-ubuddy-participant-policy="all_mentioned"[^>]*aria-checked="true"/,
  'multi-recipient task mode must default to all mentioned participants');
assert.match(openParticipantsMarkup, /<span>全部参与<\/span>/);
assert.match(openParticipantsMarkup, /<span>自动筛选<\/span>/);

state.languageMode = 'en';
const englishParticipantsMarkup = renderChat();
assert.match(englishParticipantsMarkup, /<span>Everyone<\/span>/);
assert.match(englishParticipantsMarkup, /<span>Auto select<\/span>/);
assert.doesNotMatch(englishParticipantsMarkup, /<span>全部参与<\/span>|<span>自动筛选<\/span>/,
  'English uBuddy controls must not retain Chinese participant policy labels');
state.languageMode = 'zh-CN';

state.uBuddyParticipantSelectionPolicy = 'auto_select';
const autoSelectMarkup = renderChat();
assert.match(autoSelectMarkup, /aria-checked="true"[^>]*data-ubuddy-participant-policy="auto_select"|data-ubuddy-participant-policy="auto_select"[^>]*aria-checked="true"/,
  'auto selection must be an explicit composer choice');

state.uBuddyMessageMode = 'ask';
const askMarkup = renderChat();
assert.match(askMarkup, /data-ubuddy-message-mode="ask"[^>]*class="is-active"|class="is-active"[^>]*data-ubuddy-message-mode="ask"/);
assert.match(askMarkup, /和 uBuddy 讨论/);
assert.match(askMarkup, />@09 @05 请共同完成研究任务<\/textarea>/, 'switching mode must preserve the composer draft');
assert.doesNotMatch(askMarkup, /data-ubuddy-participant-policy/,
  'participant policy is irrelevant and must stay hidden in ask mode');

state.busy = true;
const busyMarkup = renderChat();
assert.match(busyMarkup, /data-ubuddy-message-mode="task"[^>]*disabled|data-ubuddy-message-mode="ask"[^>]*disabled/,
  'mode switching must be disabled while a turn is running');

state.busy = false;
state.uBuddyFeatureFlags.messageModeV1 = false;
assert.doesNotMatch(renderChat(), /ubuddy-message-mode-picker/, 'legacy-capability renderers must keep the old composer');

const sendSource = readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
assert.match(sendSource, /const outgoingUBuddyMessageMode = activeSecretaryChat[\s\S]*UBUDDY_MESSAGE_MODES\.TASK/);
assert.match(sendSource, /uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION/);
assert.match(sendSource, /const outgoingParticipantSelectionPolicy = state\.uBuddyParticipantSelectionPolicy === 'auto_select'[\s\S]*: 'all_mentioned'/,
  'sending must snapshot the current participant-selection choice');
assert.match(sendSource, /participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION/);
assert.match(sendSource, /participantSelectionPolicy: outgoingParticipantSelectionPolicy/);
assert.match(sendSource, /state\.uBuddyParticipantSelectionPolicy = 'auto_select'/,
  'successful composer submission must reset the next task to automatic candidate selection');
assert.match(sendSource, /metadata:[\s\S]*uBuddyMessageMode: outgoingUBuddyMessageMode/,
  'the optimistic local message must record the snapshotted mode');

const appSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(appSource, /function resetWorkspaceScopedRendererState[\s\S]*state\.uBuddyMessageMode = 'task'/);
assert.match(appSource, /data-ubuddy-message-mode[\s\S]*preserveChatDraftFromInput\(\)[\s\S]*state\.uBuddyMessageMode/);
assert.match(appSource, /data-ubuddy-participant-policy-toggle[\s\S]*uBuddyParticipantSelectionMenuOpen/,
  'the participant policy trigger must open a vertical choice menu');
const chatCss = readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
assert.match(chatCss, /\.social-mention-highlight \.social-mention-token\s*\{[^}]*background:\s*transparent;/,
  'composer mentions must highlight text without a colored background');
const darkThemeFixes = readFileSync(new URL('../src/renderer/app/core/dark-theme-fixes.css', import.meta.url), 'utf8');
assert.match(darkThemeFixes, /\.shell\.theme-dark \.message \.social-mention-token\s*\{[^}]*background:\s*transparent !important;/,
  'dark message mentions must also remain background-free');
const chatViewSource = readFileSync(new URL('../src/renderer/app/views/chatView.js', import.meta.url), 'utf8');
assert.doesNotMatch(chatViewSource, /data-social-mention-toggle[^\n]*>@ 提及<\/button>/,
  'direct and group chat mention triggers must not retain a visible label after @');
assert.match(chatViewSource, /data-social-mention-toggle[^\n]*>\$\{skillPickerMode \? '\/' : '@'\}<\/button>/,
  'the shared project mention trigger must render only @, while preserving the dedicated slash picker');
assert.match(chatViewSource, /state\.uBuddyConversationOpening === true[\s\S]*state\.networkPanelView === 'messages'/,
  'uBuddy controls may appear during the explicit private-conversation opening transition');
const authSource = readFileSync(new URL('../src/renderer/app/features/settings/authController.js', import.meta.url), 'utf8');
assert.match(authSource, /state\.currentUser = boot\.currentUser \|\| null;\s*state\.uBuddyMessageMode = 'task';/);

process.stdout.write('uBuddy message mode renderer smoke passed.\n');
