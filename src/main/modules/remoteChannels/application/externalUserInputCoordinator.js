const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function normalizedQuestions(questions = []) {
  return (Array.isArray(questions) ? questions : []).map((question) => ({
    id: String(question?.id || '').trim(),
    header: String(question?.header || '').trim(),
    question: String(question?.question || '').trim(),
    isOther: Boolean(question?.isOther),
    isSecret: Boolean(question?.isSecret),
    options: Array.isArray(question?.options)
      ? question.options.map((option) => ({
          label: String(option?.label || '').trim(),
          description: String(option?.description || '').trim(),
        })).filter((option) => option.label)
      : [],
  })).filter((question) => question.id && question.question);
}

function formatQuestion(pending) {
  const question = pending.questions[pending.currentIndex];
  if (!question) return '';
  const heading = question.header ? `${question.header}\n` : '';
  const options = question.options.map((option, index) => (
    `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ''}`
  ));
  return [
    `Janus 需要你确认一项信息（${pending.currentIndex + 1}/${pending.questions.length}）`,
    '',
    `${heading}${question.question}`.trim(),
    ...(options.length ? ['', ...options] : []),
    '',
    options.length
      ? `请回复序号或选项名称${question.isOther ? '，也可以直接回复自定义内容' : ''}。`
      : '请直接回复你的答案。',
    '回复“跳过”可跳过当前问题；回复“取消”可停止本次处理。',
  ].join('\n');
}

function optionAnswer(question, text) {
  const numeric = text.match(/^([0-9]+)[.、]?$/)?.[1] || '';
  if (numeric) return question.options[Number(numeric) - 1]?.label || '';
  return question.options.find((option) => option.label.toLowerCase() === text.toLowerCase())?.label || '';
}

export class ExternalUserInputCoordinator {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, onExpired = () => {} } = {}) {
    this.timeoutMs = Math.max(1, Number(timeoutMs || DEFAULT_TIMEOUT_MS));
    this.onExpired = onExpired;
    this.pending = new Map();
  }

  begin(key, request = {}) {
    const normalizedKey = String(key || '').trim();
    const questions = normalizedQuestions(request.questions);
    if (!normalizedKey || !questions.length) return { ok: false, reason: 'invalid_request' };
    if (questions.some((question) => question.isSecret)) return { ok: false, reason: 'secret_question' };
    this.clear(normalizedKey);
    const pending = {
      key: normalizedKey,
      runId: String(request.runId || ''),
      requestId: String(request.requestId || ''),
      sourceMessageId: String(request.sourceMessageId || ''),
      questions,
      currentIndex: 0,
      answers: {},
      skippedQuestionIds: [],
      timer: null,
    };
    pending.timer = setTimeout(() => {
      if (this.pending.get(normalizedKey) !== pending) return;
      this.pending.delete(normalizedKey);
      Promise.resolve(this.onExpired(pending)).catch(() => {});
    }, this.timeoutMs);
    pending.timer.unref?.();
    this.pending.set(normalizedKey, pending);
    return { ok: true, pending, prompt: formatQuestion(pending) };
  }

  has(key) {
    return this.pending.has(String(key || '').trim());
  }

  clear(key, requestId = '') {
    const normalizedKey = String(key || '').trim();
    const pending = this.pending.get(normalizedKey);
    if (!pending || (requestId && pending.requestId !== String(requestId))) return null;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(normalizedKey);
    return pending;
  }

  consume(key, input) {
    const normalizedKey = String(key || '').trim();
    const pending = this.pending.get(normalizedKey);
    if (!pending) return { handled: false };
    const text = String(input || '').trim();
    if (/^(?:取消|cancel)$/i.test(text)) {
      this.clear(normalizedKey, pending.requestId);
      return { handled: true, status: 'cancelled', pending };
    }
    const question = pending.questions[pending.currentIndex];
    if (/^(?:跳过|skip)$/i.test(text)) {
      pending.skippedQuestionIds.push(question.id);
    } else {
      const selected = question.options.length ? optionAnswer(question, text) : text;
      const answer = selected || (question.options.length && question.isOther ? text : '');
      if (!answer) {
        return {
          handled: true,
          status: 'invalid',
          message: `没有找到对应选项，请回复 1-${question.options.length}、完整选项名称或“跳过”。`,
        };
      }
      pending.answers[question.id] = { answers: [answer] };
    }
    pending.currentIndex += 1;
    if (pending.currentIndex < pending.questions.length) {
      return { handled: true, status: 'next', pending, prompt: formatQuestion(pending) };
    }
    this.clear(normalizedKey, pending.requestId);
    return {
      handled: true,
      status: 'completed',
      pending,
      answers: pending.answers,
      skippedQuestionIds: pending.skippedQuestionIds,
    };
  }

  size() {
    return this.pending.size;
  }
}

export const externalUserInputInternals = { formatQuestion, normalizedQuestions, optionAnswer };
