import { normalizeUiLanguage, uiText } from './uiLanguage.js';

export const UBUDDY_CONTROL_MESSAGE_KIND = Object.freeze({
  WELCOME: 'welcome',
  IDENTITY: 'identity',
  GREETING: 'greeting',
});

const UBUDDY_CONTROL_MESSAGES = Object.freeze({
  [UBUDDY_CONTROL_MESSAGE_KIND.WELCOME]: Object.freeze({
    zh: '我是 uBuddy。你可以直接告诉我目标、交付物和截止要求；简单任务我会直接处理，只在明确超出职责或能力时调用 Agent 或建立协作。',
    en: "I'm uBuddy. Tell me your goal, deliverables, and deadline. I'll handle simple tasks directly, and only call an Agent or start a collaboration when the work clearly falls outside my role or capabilities.",
  }),
  [UBUDDY_CONTROL_MESSAGE_KIND.IDENTITY]: Object.freeze({
    zh: '我是你的 uBuddy，也是 Janus 的任务入口。我会用一次模型决策判断当前消息应直接回答、先澄清，还是形成正式任务图；正式本地任务即使只需要一个 Agent，也会交给 Scheduler 分配和跟踪。',
    en: "I'm your uBuddy and the task entry point for Janus. I use a model decision to determine whether to answer directly, clarify first, or create a formal task graph. Even a formal local task that needs only one Agent is assigned and tracked through Scheduler.",
  }),
  [UBUDDY_CONTROL_MESSAGE_KIND.GREETING]: Object.freeze({
    zh: '你好！我是你的 uBuddy。你可以直接告诉我目标和期望交付物；我会判断是直接回答、先澄清，还是规划 Agent 任务图并交给 Scheduler 执行。',
    en: "Hi! I'm your uBuddy. Tell me your goal and expected deliverables, and I'll decide whether to answer directly, clarify first, or plan an Agent task graph for Scheduler to execute.",
  }),
});

export function uBuddyControlMessageKind(metadata = {}) {
  if (metadata?.welcome === true) return UBUDDY_CONTROL_MESSAGE_KIND.WELCOME;
  if (metadata?.identityControl === true) return UBUDDY_CONTROL_MESSAGE_KIND.IDENTITY;
  if (metadata?.greetingControl === true) return UBUDDY_CONTROL_MESSAGE_KIND.GREETING;
  return '';
}

export function uBuddyControlMessageText(kind = '', language = 'zh-CN') {
  const message = UBUDDY_CONTROL_MESSAGES[String(kind || '')];
  return message ? uiText(message.zh, message.en, language) : '';
}

export function detectUBuddyControlLanguage(message = '', fallbackLanguage = 'zh-CN') {
  const text = String(message || '').trim();
  if (/\p{Script=Han}/u.test(text) || /^(?:ni\s*hao)(?:\s+u?buddy)?[?.!,\s]*$/i.test(text)) return 'zh-CN';
  if (/[A-Za-z]/.test(text)) return 'en';
  return normalizeUiLanguage(fallbackLanguage);
}
