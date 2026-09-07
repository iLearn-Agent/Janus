import { classifySecretaryTaskQuery } from './secretaryTaskQuery.js';

export const TASK_WORKSPACE_INTENT_VERSION = 'TASK_WORKSPACE_INTENT_V1';

const INTENTS = new Set(['query', 'accept_submission', 'supplement', 'cancel', 'clarification']);

export async function classifyTaskWorkspaceIntent({
  content = '', actionHint = '', submissionId = '', execute = null, root = '', cwd = '', model = '', reasoningEffort = '', signal = null,
  executionContext = null,
} = {}) {
  const deterministic = deterministicTaskWorkspaceIntent({ content, actionHint, submissionId });
  if (deterministic) return deterministic;
  if (typeof execute !== 'function') return { intent: 'supplement', queryIntent: '', requestedSubmissionNo: 0 };
  const prompt = [
    `【${TASK_WORKSPACE_INTENT_VERSION}】`,
    '你只判断用户在某一个已经存在的任务工作区里希望系统采取什么动作，不执行任务。',
    '可选 intent：query（询问进度、结果、文件或验收情况）；accept_submission（采用某个已有版本并停止任务）；supplement（新增或修改要求，进入后续 FIFO 轮次）；cancel（停止且不交付）；clarification（无法判断）。',
    '仅输出 JSON：{"version":"TASK_WORKSPACE_INTENT_V1","intent":"query|accept_submission|supplement|cancel|clarification","requestedSubmissionNo":0,"reason":"..."}',
    `用户输入：${String(content || '').trim()}`,
  ].join('\n');
  try {
    const answer = await execute({
      prompt,
      agentId: 'secretary_agent',
      role: 'ubuddy_task_workspace_intent',
      root,
      cwd: cwd || root,
      sandbox: 'read-only',
      timeoutMs: 30_000,
      signal,
      model,
      reasoningEffort,
      harnessMode: 'raw',
      executionContext,
    });
    const parsed = parseIntentAnswer(answer);
    if (parsed) return parsed;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return { intent: 'supplement', queryIntent: '', requestedSubmissionNo: 0 };
}

export function deterministicTaskWorkspaceIntent({ content = '', actionHint = '', submissionId = '' } = {}) {
  const hint = String(actionHint || '').trim().toLowerCase();
  if (hint === 'accept_submission' && submissionId) {
    return { intent: 'accept_submission', queryIntent: '', requestedSubmissionNo: 0, submissionId: String(submissionId) };
  }
  if (hint === 'query') return { intent: 'query', queryIntent: 'progress', requestedSubmissionNo: 0 };
  if (hint === 'cancel') return { intent: 'cancel', queryIntent: '', requestedSubmissionNo: 0 };
  if (['supplement', 'request_revision'].includes(hint)) return { intent: 'supplement', queryIntent: '', requestedSubmissionNo: 0 };

  const text = String(content || '').trim();
  if (!text) return null;
  if (/^(?:请|麻烦)?(?:停止|取消|终止)(?:这个|当前)?任务[。！!\s]*$/i.test(text)) {
    return { intent: 'cancel', queryIntent: '', requestedSubmissionNo: 0 };
  }
  if (ownerAcceptanceMessage(text)) {
    return {
      intent: 'accept_submission',
      queryIntent: '',
      requestedSubmissionNo: referencedSubmissionNo(text),
      submissionId: '',
    };
  }
  const queryIntent = classifySecretaryTaskQuery(text);
  if (queryIntent) return { intent: 'query', queryIntent, requestedSubmissionNo: 0 };
  if (/(?:为什么|为何).{0,12}(?:打回|不通过|没通过)|(?:验收|打回|修改).{0,10}(?:原因|意见|要求|问题)|(?:哪里|哪些).{0,8}(?:不合格|有问题)|uBuddy.{0,8}(?:不满意|要求|意见)/i.test(text)) {
    return { intent: 'query', queryIntent: 'review', requestedSubmissionNo: 0 };
  }
  if (/[？?]\s*$/.test(text) || /^(?:现在|当前|这个任务).{0,20}(?:怎么样|如何|什么情况)/i.test(text)) {
    return { intent: 'query', queryIntent: 'progress', requestedSubmissionNo: 0 };
  }
  if (/(?:修改|增加|补充|删掉|删除|调整|改成|重做|重新|继续|完善|优化|换成|加入|不要)/i.test(text)) {
    return { intent: 'supplement', queryIntent: '', requestedSubmissionNo: 0 };
  }
  return null;
}

export function buildTaskWorkspaceReviewReply(task = {}) {
  const review = task.deliveryReview || task.metadata?.deliveryReview || null;
  const submissions = Array.isArray(task.deliverySubmissions) ? task.deliverySubmissions : [];
  if (!review) return `任务“${task.title || '当前任务'}”还没有进入 uBuddy 交付验收。`;
  const lines = [
    `任务“${task.title || '当前任务'}”的验收状态：${reviewStateLabel(review.state)}。`,
    `已保存 ${submissions.length} 个交付版本；当前质量修改 ${Number(review.qualityRevisionCount || 0)}/${Number(review.maxQualityRevisions || review.revisionLimit || 2)}。`,
  ];
  if (review.summary) lines.push(`uBuddy 结论：${review.summary}`);
  if (review.failedChecks?.length) lines.push(`未通过项：${review.failedChecks.map((item) => item.summary || item.code).filter(Boolean).join('；')}`);
  if (review.requiredChanges?.length) lines.push(`要求修改：${review.requiredChanges.join('；')}`);
  const latest = submissions.at(-1);
  if (latest) lines.push(`当前最新保存版本：版本 ${latest.submissionNo}。你可以预览后说“采用最新版”，或明确说“采用第 ${latest.submissionNo} 版”。`);
  return lines.join('\n');
}

function ownerAcceptanceMessage(text = '') {
  return /(?:采用|选用|使用|就要|选择|确认使用|直接交付|交付).{0,12}(?:第?[一二三四五六七八九十\d]+版|这个版本|这版|当前版|最新版)/i.test(text)
    || /(?:这个版本|这版|当前版|最新版).{0,10}(?:可以了|可以|满意|没问题|就行|交付|采用)/i.test(text)
    || /^(?:可以了|就这样|这版行|这版可以|我满意了)[。！!\s]*$/i.test(text);
}

function referencedSubmissionNo(text = '') {
  const arabic = /第?\s*(\d{1,3})\s*版/i.exec(text);
  if (arabic) return Math.max(0, Number(arabic[1] || 0));
  const chinese = /第?\s*([一二三四五六七八九十]{1,3})\s*版/.exec(text);
  return chinese ? chineseNumber(chinese[1]) : 0;
}

function chineseNumber(value = '') {
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    return (left ? digits[left] || 0 : 1) * 10 + (right ? digits[right] || 0 : 0);
  }
  return digits[value] || 0;
}

function parseIntentAnswer(answer = '') {
  try {
    const text = String(answer || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(text);
    if (parsed?.version !== TASK_WORKSPACE_INTENT_VERSION || !INTENTS.has(String(parsed.intent || ''))) return null;
    return {
      intent: String(parsed.intent),
      queryIntent: String(parsed.queryIntent || ''),
      requestedSubmissionNo: Math.max(0, Number(parsed.requestedSubmissionNo || 0)),
      submissionId: String(parsed.submissionId || ''),
    };
  } catch {
    return null;
  }
}

function reviewStateLabel(state = '') {
  return ({
    submitted: '已提交', verifying: 'uBuddy 验收中', revision_requested: '等待修改', reworking: 'Agent 修改中',
    accepted: '已交付', action_required: '需要用户处理', revision_exhausted: '自动修改次数已用尽', failed: '验收终止',
  })[String(state || '')] || String(state || '未知');
}
