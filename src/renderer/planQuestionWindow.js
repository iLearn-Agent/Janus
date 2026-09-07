import { localizeDom, normalizeLanguage, translateUiText, translateUserVisibleError } from './app/i18n.js';

const root = document.getElementById('plan-question-window');
const query = new URLSearchParams(location.search);
const token = query.get('token') || '';
const language = normalizeLanguage(query.get('language') || document.documentElement.lang || 'en');
let payload = null;
let questionIndex = 0;
const answers = {};

void initialize();

async function initialize() {
  payload = await window.janus.auxiliaryWindowPayload({ token });
  if (!payload?.requestId || !Array.isArray(payload.questions) || !payload.questions.length) {
    root.innerHTML = '<div class="question-window-error">计划问题已失效，请返回主界面重试。</div>';
    localizeDom(root, language);
    root.removeAttribute('aria-busy');
    return;
  }
  renderQuestion();
}

function renderQuestion(error = '') {
  const question = payload.questions[questionIndex];
  const english = language === 'en';
  const windowTitle = payload.planMode === false ? '补充所需信息' : '确认计划选项';
  document.title = translateUiText(windowTitle, language);
  const options = Array.isArray(question.options) ? question.options : [];
  const saved = answers[question.id] || '';
  root.innerHTML = `
    <header class="question-window-header">
      <span class="question-window-icon" aria-hidden="true">☷</span>
      <span><strong>${windowTitle}</strong><small>问题 ${questionIndex + 1} / ${payload.questions.length} · 可随时切换回 Janus 查看对话</small></span>
      <button type="button" data-focus-main>查看主界面</button>
    </header>
    <section class="question-window-card">
      <div class="question-window-progress"><i style="width:${Math.round(((questionIndex + 1) / payload.questions.length) * 100)}%"></i></div>
      <div class="question-window-question" data-no-localize><small>${escapeHtml(question.header || `问题 ${questionIndex + 1}`)}</small><h1>${escapeHtml(question.question || '')}</h1></div>
      <div class="question-window-options">
        ${options.map((option, index) => optionMarkup(option, index, saved)).join('')}
        ${(question.isOther || (payload.planMode !== false && options.length && !question.isSecret)) ? otherMarkup(saved, english) : ''}
        ${options.length ? '' : `<textarea data-free-answer placeholder="${english ? 'Enter your answer' : '请输入你的回答'}">${escapeHtml(saved)}</textarea>`}
      </div>
      <p class="question-window-error" ${error ? '' : 'hidden'}>${escapeHtml(error)}</p>
    </section>
    <footer class="question-window-footer">
      <span>${payload.planMode === false ? (english ? 'Janus will continue this task after submission.' : '提交后 Janus 会继续当前任务。') : (english ? 'Your choice refines the plan; no files will be changed yet.' : '选择只会细化计划，不会开始修改文件。')}</span>
      <div><button type="button" data-question-back ${questionIndex === 0 ? 'disabled' : ''}>${english ? 'Back' : '上一步'}</button><button class="is-primary" type="button" data-question-next>${questionIndex === payload.questions.length - 1 ? (english ? 'Confirm and generate plan' : '确认并继续生成计划') : (english ? 'Next' : '下一题')}</button></div>
    </footer>`;
  root.removeAttribute('aria-busy');
  localizeDom(root, language);
  root.querySelector('[data-focus-main]')?.addEventListener('click', () => window.janus.focusMainWindow());
  root.querySelector('[data-question-back]')?.addEventListener('click', () => {
    saveCurrentAnswer({ required: false });
    questionIndex = Math.max(0, questionIndex - 1);
    renderQuestion();
  });
  root.querySelector('[data-question-next]')?.addEventListener('click', advance);
  root.querySelectorAll('[data-other-answer]').forEach((input) => input.addEventListener('focus', () => {
    const radio = input.closest('label')?.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
  }));
}

async function advance() {
  const answer = saveCurrentAnswer({ required: true });
  if (!answer) return;
  if (questionIndex < payload.questions.length - 1) {
    questionIndex += 1;
    renderQuestion();
    return;
  }
  const button = root.querySelector('[data-question-next]');
  if (button) { button.disabled = true; button.textContent = translateUiText('正在提交…', language); }
  const normalized = Object.fromEntries(payload.questions.map((question) => [question.id, { answers: [answers[question.id]] }]));
  try {
    const result = await window.janus.resolveChatUserInput({
      channelId: payload.channelId,
      runId: payload.runId,
      requestId: payload.requestId,
      answers: normalized,
    });
    if (!result?.ok) throw new Error(result?.reason || '补充信息请求已经失效。');
    await window.janus.closeAuxiliaryWindow({ token, submitted: true });
  } catch (error) {
    renderQuestion(language === 'en'
      ? translateUserVisibleError(error?.message || error, language, error)
      : `提交失败：${error.message || error}`);
  }
}

function saveCurrentAnswer({ required }) {
  const question = payload.questions[questionIndex];
  let answer = '';
  const selected = root.querySelector('input[type="radio"]:checked');
  if (selected?.value === '__other__') answer = String(root.querySelector('[data-other-answer]')?.value || '').trim();
  else if (selected) answer = String(selected.value || '').trim();
  else answer = String(root.querySelector('[data-free-answer]')?.value || '').trim();
  if (!answer && required) {
    renderQuestion(`请完成“${question.header || question.question}”后再继续。`);
    return '';
  }
  if (answer) answers[question.id] = answer;
  return answer;
}

function optionMarkup(option, index, saved) {
  const label = String(option?.label || '');
  return `<label class="question-window-option"><input type="radio" name="answer" value="${escapeAttr(label)}" ${saved === label ? 'checked' : ''}><span class="question-window-radio"></span><span><strong><span data-no-localize>${escapeHtml(label)}</span>${index === 0 ? '<b>推荐</b>' : ''}</strong>${option?.description ? `<small data-no-localize>${escapeHtml(option.description)}</small>` : ''}</span></label>`;
}

function otherMarkup(saved, english = false) {
  const optionLabels = (payload.questions[questionIndex].options || []).map((option) => String(option?.label || ''));
  const otherValue = saved && !optionLabels.includes(saved) ? saved : '';
  return `<label class="question-window-option is-other"><input type="radio" name="answer" value="__other__" ${otherValue ? 'checked' : ''}><span class="question-window-radio"></span><span><strong>${english ? 'Other' : '其他'}</strong><small>${english ? 'Enter an answer that better fits your needs' : '输入更符合你需求的方案'}</small></span><input data-other-answer value="${escapeAttr(otherValue)}" placeholder="${english ? 'Enter your choice' : '请输入你的选择'}"></label>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function escapeAttr(value) { return escapeHtml(value); }
