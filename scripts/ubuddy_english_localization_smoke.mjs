import assert from 'node:assert/strict';

import { translateUBuddyMessageText, translateUiText } from '../src/renderer/app/i18n.js';
import { state } from '../src/renderer/app/state.js';
import { renderChat, renderMessageList } from '../src/renderer/app/views/chatView.js';
import { combinedUpdateMessage } from '../src/renderer/app/views/settingsView.js';
import { ensureSecretaryConversationSeed } from '../src/main/modules/collaboration/application/secretaryDelegationRules.js';

const templates = [
  '当前有多个任务正在运行或等待。请选择要继续的任务，或明确选择“创建新任务”后再发送。',
  '已取消本次多人分工，没有创建任务、委托或协作组。',
  'uBuddy 未能完成任务信息检查，因此没有创建任务、协作组或委托。请重试；错误信息：timeout',
  '已停止交给 General Agent 的任务。已完成内容会保留。',
  '任务已交给 General Agent 的单 Agent 工作区；没有创建任务图或任务群。',
  '当前有多个任务正在执行，请从对应进度记录停止：\n- Report（任务图 task-1）\n- General Agent 直接任务（work-1）',
  '任务“Report”当前状态：执行中。\n结果摘要：Draft ready\n产物位置：\n- report.md\n任务仍在执行，后续节点可能继续生成或更新产物。',
  '当前有 2 个相关任务：\n- Report A：执行中，已完成 1/3 个节点。\n  正在处理：Draft。\n- Report B：等待信息，已完成 0/2 个节点。\n如需查看某一个任务的详细进度，请回复任务名称。',
  '任务“Report”的验收状态：等待修改。\n已保存 2 个交付版本；当前质量修改 1/2。\nuBuddy 结论：Needs stronger evidence\n当前最新保存版本：版本 2。你可以预览后说“采用最新版”，或明确说“采用第 2 版”。',
  'uBuddy 已生成第 2 版分工方案，尚未派发。\n协作模式：负责人派发：发起人只负责协调与最终汇总\n\n最终整合：发起人的 uBuddy\n请确认后再派发；也可以要求修改、改为全员参与或取消。',
  '任务图已完成，leader（General Agent）已接管；uBuddy 现在休眠，完成、失败或需要你操作时会由 Scheduler 唤醒。',
  'General Agent 已完成任务：\n\nDelivery body',
  'General Agent 执行失败：timeout。点击可打开该 Agent 会话查看详情。',
  'Alice 的 uBuddy 向我派发了任务“Prepare report”。我已收到，正在规划 Agent 和执行步骤。',
  'Buddy agent 已提交任务结果，等待你验收：Prepare report',
  '接收方当前设备尚未安装 PPT 制作 Skill，PPT Agent 因此无法执行任务。请接收方先安装 Skill，并确认 PPT Agent 已招募启用后重新调度；任务上下文已保留。',
  '接收方当前没有已招募并启用的 PPT Agent。请接收方完成招募或重新启用后再调度；任务上下文已保留。',
];

for (const source of templates) {
  const translated = translateUBuddyMessageText(source, 'en');
  assert.doesNotMatch(translated, /[\u3400-\u9fff]/u, `${source}\n=>\n${translated}`);
}

assert.equal(
  translateUBuddyMessageText('这是用户要求保留的中文交付正文。', 'en'),
  '这是用户要求保留的中文交付正文。',
);

for (const label of [
  '多人分工方案', '参与人选择', '等待确认', '最终整合：发起人的 uBuddy',
  '需要你确认', '选择执行方式', '生成超时',
  '自动 Profile 筛选未启用，沿用所有明确 @ 用户参与的兼容行为。',
]) {
  assert.doesNotMatch(translateUiText(label, 'en'), /[\u3400-\u9fff]/u, label);
}

state.messages = [{
  id: 'old-welcome',
  role: 'assistant',
  content: '我是 uBuddy。你可以直接告诉我目标、交付物和截止要求；简单任务我会直接处理，只在明确超出职责或能力时调用 Agent 或建立协作。',
  metadata: { secretaryControl: true, welcome: true },
}];
state.languageMode = 'en';
assert.equal(
  combinedUpdateMessage({ available: true, version: '0.1.21' }, {}),
  'A newer software version 0.1.21 is available. Please update the app first.',
);
assert.doesNotMatch(combinedUpdateMessage({ available: true, version: '0.1.21' }, {}), /[\u3400-\u9fff]/u);
state.homeMode = 'secretary';
state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), messageModeV1: true };
state.uBuddyMessageMode = 'ask';
state.uBuddyMessageModeMenuOpen = true;
state.currentSessionId = '';
state.currentAgentId = '';
state.currentAgentInstanceId = '';
state.currentDepartmentId = '';
state.chatDraft = '';
state.attachments = [];
state.activeChatRun = null;
const englishAskComposer = renderChat();
assert.match(englishAskComposer, /data-ubuddy-message-mode="ask"[^>]*>[^]*<span>Ask<\/span>/);
assert.match(englishAskComposer, /placeholder="Ask uBuddy"/);
assert.doesNotMatch(englishAskComposer, />讨论<\/button>|和 uBuddy 讨论/);
const english = renderMessageList();
assert.equal(english, '');
assert.doesNotMatch(english, /我是 uBuddy/);

state.languageMode = 'zh-CN';
const chinese = renderMessageList();
assert.equal(chinese, '');

let welcomeWriteAttempted = false;
const seedResult = ensureSecretaryConversationSeed({
  addMessage() { welcomeWriteAttempted = true; },
}, { id: 'new-ubuddy-session' }, 'zh-CN');
assert.equal(seedResult, null);
assert.equal(welcomeWriteAttempted, false, 'new uBuddy conversations must not persist the removed welcome message');

console.log('uBuddy English localization smoke passed');
