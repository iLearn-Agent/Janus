import { escapeAttr, escapeHtml } from '../utils/format.js';

const REVIEW_DIFF_LINE_LIMIT = 1800;
const HOVER_DIFF_LINE_LIMIT = 32;
const SUMMARY_VISIBLE_FILE_COUNT = 3;

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedEvent(item = {}) {
  const payload = item?.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload
    : {};
  return { ...item, ...payload };
}

function normalizePath(value = '') {
  return safeText(value).replaceAll('\\', '/').replace(/\/{2,}/g, '/');
}

function rawChangeKind(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return safeText(value.type || value.kind || value.operation || value.value);
  }
  const text = safeText(value);
  return text === '[object Object]' ? '' : text;
}

function canonicalChangeKind(value = '') {
  const kind = rawChangeKind(value).toLowerCase();
  if (['add', 'added', 'create', 'created'].includes(kind)) return 'add';
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'delete';
  if (['move', 'moved', 'rename', 'renamed'].includes(kind)) return 'move';
  if (['update', 'updated', 'modify', 'modified'].includes(kind)) return 'update';
  return '';
}

function protocolChangeKind(change = {}, event = {}) {
  const targetPath = normalizePath(change.moveRelativePath || change.relativePath || change.movePath || change.path).toLowerCase();
  for (const protocolEvent of Array.isArray(event.protocolEvents) ? event.protocolEvents : []) {
    const params = protocolEvent?.params && typeof protocolEvent.params === 'object' ? protocolEvent.params : {};
    const candidates = Array.isArray(params?.item?.changes) ? params.item.changes : Array.isArray(params.changes) ? params.changes : [];
    for (const candidate of candidates) {
      const candidatePath = normalizePath(candidate?.moveRelativePath || candidate?.relativePath || candidate?.movePath || candidate?.path).toLowerCase();
      if (targetPath && candidatePath && targetPath !== candidatePath && !targetPath.endsWith(`/${candidatePath}`) && !candidatePath.endsWith(`/${targetPath}`)) continue;
      const kind = canonicalChangeKind(candidate?.kind || candidate?.type);
      if (kind) return kind;
    }
  }
  return '';
}

function changeOperation(change = {}, event = {}) {
  return canonicalChangeKind(change.kind || change.type || change?.comparison?.operation)
    || protocolChangeKind(change, event)
    || 'update';
}

function displayFilePath(change = {}, event = {}) {
  const relative = normalizePath(change.moveRelativePath || change.relativePath);
  if (relative) return relative.replace(/^\.\//, '');
  const target = normalizePath(change.movePath || change.path);
  const root = normalizePath(change.workspaceRoot || event.workspaceRoot).replace(/\/+$/, '');
  if (target && root && (target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
    return target.slice(root.length).replace(/^\/+/, '') || target.split('/').at(-1) || target;
  }
  const projectPart = target.match(/\/(src|scripts|assets|docs|test|tests|cloud|network)\/.+$/);
  return projectPart ? projectPart[0].slice(1) : target.split('/').filter(Boolean).at(-1) || target;
}

function changeKindLabel(value = '') {
  return ({
    add: '新增', create: '新增', added: '新增',
    update: '已编辑', modify: '已编辑', modified: '已编辑',
    delete: '已删除', deleted: '已删除', remove: '已删除', removed: '已删除',
    move: '已移动', moved: '已移动', rename: '已移动', renamed: '已移动',
  })[safeText(value).toLowerCase()] || '已编辑';
}

function metricNumber(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function createdContentMetric(change = {}, event = {}) {
  const comparison = change?.comparison && typeof change.comparison === 'object' ? change.comparison : {};
  const operation = changeOperation(change, event);
  if (operation !== 'add') return null;
  const metrics = comparison?.semantic?.afterMetrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const kind = safeText(comparison.kind).toLowerCase();
  if (kind === 'docx') {
    const parts = [
      metricNumber(metrics.headings) !== null ? '\u6807\u9898 ' + metricNumber(metrics.headings) : '',
      metricNumber(metrics.paragraphs) !== null ? '\u6bb5\u843d ' + metricNumber(metrics.paragraphs) : '',
      metricNumber(metrics.lists) !== null ? '\u5217\u8868 ' + metricNumber(metrics.lists) : '',
      metricNumber(metrics.tables) !== null ? '\u8868\u683c ' + metricNumber(metrics.tables) : '',
    ].filter(Boolean);
    if (parts.length) return { label: parts.join(' \u00b7 '), summary: '\u65b0\u589e\u6587\u6863 \u00b7 ' + parts.join(' \u00b7 ') };
  }
  if (kind === 'pptx') {
    const slides = metricNumber(metrics.slides);
    if (slides !== null) return slides > 0
      ? { unit: '\u5f20\u5e7b\u706f\u7247', value: slides, label: '\u5e7b\u706f\u7247 ' + slides, summary: '\u65b0\u589e ' + slides + ' \u5f20\u5e7b\u706f\u7247' }
      : { label: '\u7a7a\u6f14\u793a\u6587\u7a3f', summary: '\u65b0\u589e\u7a7a\u6f14\u793a\u6587\u7a3f' };
  }
  if (kind === 'image') {
    const width = metricNumber(metrics.width);
    const height = metricNumber(metrics.height);
    const bytes = metricNumber(metrics.bytes);
    const parts = [
      width && height ? width + ' \u00d7 ' + height : '',
      bytes !== null ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : '',
    ].filter(Boolean);
    if (parts.length) return { label: parts.join(' \u00b7 '), summary: '\u65b0\u589e\u56fe\u7247 \u00b7 ' + parts.join(' \u00b7 ') };
  }
  const characters = metricNumber(metrics.characters);
  if (characters !== null) return characters > 0
    ? { unit: '\u5b57\u7b26', value: characters, label: '\u5b57\u7b26 ' + characters, summary: '\u65b0\u589e ' + characters + ' \u5b57\u7b26' }
    : { label: '\u7a7a\u6587\u4ef6', summary: '\u65b0\u589e\u7a7a\u6587\u4ef6' };
  const lines = metricNumber(metrics.lines);
  if (lines !== null) return lines > 0
    ? { unit: '\u884c', value: lines, label: lines + ' \u884c', summary: '\u65b0\u589e ' + lines + ' \u884c' }
    : { label: '\u7a7a\u6587\u4ef6', summary: '\u65b0\u589e\u7a7a\u6587\u4ef6' };
  return null;
}

function parseDiff(diff = '', { operation = '' } = {}) {
  const source = String(diff || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const binary = /(?:^|\n)(?:GIT binary patch|Binary files .+ differ)(?:\n|$)/i.test(source);
  if (!source || binary) return { additions: 0, deletions: 0, binary, lines: [] };
  const normalizedOperation = canonicalChangeKind(operation);
  const unified = /^(?:diff --git|@@\s|---\s|\+\+\+\s)/m.test(source);
  if (!unified && ['add', 'delete'].includes(normalizedOperation)) {
    const content = source.endsWith('\n') ? source.slice(0, -1) : source;
    const contentLines = content ? content.split('\n') : [];
    return {
      additions: normalizedOperation === 'add' ? contentLines.length : 0,
      deletions: normalizedOperation === 'delete' ? contentLines.length : 0,
      binary: false,
      lines: contentLines.map((text, index) => ({
        type: normalizedOperation,
        oldNumber: normalizedOperation === 'delete' ? index + 1 : '',
        newNumber: normalizedOperation === 'add' ? index + 1 : '',
        text,
      })),
    };
  }
  let oldLine = null;
  let newLine = null;
  let additions = 0;
  let deletions = 0;
  const lines = source.split('\n').map((text) => {
    if (/^@@\s/.test(text)) {
      const match = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      return { type: 'hunk', oldNumber: '', newNumber: '', text };
    }
    if (/^(?:diff --git|index |new file mode |deleted file mode |similarity index |rename from |rename to|--- |\+\+\+ )/.test(text)) {
      if (/^diff --git/.test(text)) {
        oldLine = null;
        newLine = null;
      }
      return { type: 'meta', oldNumber: '', newNumber: '', text };
    }
    if (/^\\ No newline at end of file/.test(text)) return { type: 'meta', oldNumber: '', newNumber: '', text };
    if (text.startsWith('+')) {
      const line = { type: 'add', oldNumber: '', newNumber: Number.isInteger(newLine) ? newLine : '', text: text.slice(1) };
      if (Number.isInteger(newLine)) newLine += 1;
      additions += 1;
      return line;
    }
    if (text.startsWith('-')) {
      const line = { type: 'delete', oldNumber: Number.isInteger(oldLine) ? oldLine : '', newNumber: '', text: text.slice(1) };
      if (Number.isInteger(oldLine)) oldLine += 1;
      deletions += 1;
      return line;
    }
    const inHunk = Number.isInteger(oldLine) || Number.isInteger(newLine);
    const line = {
      type: inHunk ? 'context' : 'meta',
      oldNumber: Number.isInteger(oldLine) ? oldLine : '',
      newNumber: Number.isInteger(newLine) ? newLine : '',
      text: inHunk && text.startsWith(' ') ? text.slice(1) : text,
    };
    if (Number.isInteger(oldLine)) oldLine += 1;
    if (Number.isInteger(newLine)) newLine += 1;
    return line;
  });
  return { additions, deletions, binary: false, lines };
}

function gitDiffPath(value = '') {
  const path = safeText(value).replace(/^"|"$/g, '').replace(/^[ab]\//, '');
  return path === '/dev/null' ? '' : path;
}

function filesFromTurnDiff(diff = '') {
  const source = String(diff || '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (!/^diff --git\s/m.test(source)) return [];
  return source.split(/(?=^diff --git\s)/m).filter((block) => /^diff --git\s/.test(block)).map((block, index) => {
    const header = block.match(/^diff --git\s+(?:"?a\/(.+?)"?)\s+(?:"?b\/(.+?)"?)$/m);
    const beforePath = gitDiffPath(header?.[1] || block.match(/^---\s+(.+)$/m)?.[1] || '');
    const afterPath = gitDiffPath(header?.[2] || block.match(/^\+\+\+\s+(.+)$/m)?.[1] || '');
    const kind = /^new file mode\s/m.test(block)
      ? 'add'
      : /^deleted file mode\s/m.test(block)
        ? 'delete'
        : /^(?:rename from|rename to)\s/m.test(block)
          ? 'move'
          : 'update';
    const parsed = parseDiff(block);
    return {
      id: `file-${index}`,
      path: afterPath || beforePath,
      kind,
      label: changeKindLabel(kind),
      additions: parsed.additions,
      deletions: parsed.deletions,
      binary: parsed.binary,
      diff: block,
    };
  }).filter((file) => file.path);
}

function mergeFileChange(target, change = {}, event = {}) {
  target.kind = changeOperation(change, event) || target.kind;
  target.label = changeKindLabel(target.kind);
  const diff = typeof change.diff === 'string' ? change.diff : '';
  if (diff && !target.diffSet.has(diff)) {
    target.diffSet.add(diff);
    target.diffs.push(diff);
    const parsed = parseDiff(diff, { operation: target.kind });
    target.additions += parsed.additions;
    target.deletions += parsed.deletions;
    target.binary = target.binary || parsed.binary;
  }
  target.path = displayFilePath(change, event) || target.path;
  target.createdContentMetric ||= createdContentMetric(change, event);
}

export function codexTurnChangeModel(events = []) {
  const normalizedEvents = (Array.isArray(events) ? events : []).map(normalizedEvent);
  const contentMetricsByPath = new Map();
  for (const item of normalizedEvents) {
    if (item.activityType !== 'file' || ['failed', 'cancelled', 'blocked'].includes(String(item.status || ''))) continue;
    for (const change of Array.isArray(item.changes) ? item.changes : []) {
      const path = displayFilePath(change, item);
      const metric = createdContentMetric(change, item);
      if (path && metric) contentMetricsByPath.set(path.toLowerCase(), metric);
    }
  }
  const turnDiffCandidates = normalizedEvents
    .filter((item) => item.activityType === 'file' && !['failed', 'cancelled', 'blocked'].includes(String(item.status || '')))
    .filter((item) => !Array.isArray(item.changes) || !item.changes.length || /^turn-diff-/.test(String(item.activityId || '')) || /本轮文件变更/.test(String(item.title || '')))
    .map((item) => safeText(item.diff))
    .filter((diff) => /^diff --git\s/m.test(diff))
  const fallbackDiffCandidates = normalizedEvents
    .filter((item) => item.activityType === 'file' && !['failed', 'cancelled', 'blocked'].includes(String(item.status || '')))
    .map((item) => safeText(item.diff))
    .filter((diff) => /^diff --git\s/m.test(diff));
  const authoritativeTurnDiff = turnDiffCandidates.at(-1) || fallbackDiffCandidates.at(-1) || '';
  const turnDiffFiles = filesFromTurnDiff(authoritativeTurnDiff);
  if (turnDiffFiles.length) {
    const enrichedFiles = turnDiffFiles.map((file) => ({
      ...file,
      createdContentMetric: contentMetricsByPath.get(file.path.toLowerCase()) || null,
    }));
    return {
      files: enrichedFiles,
      additions: enrichedFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: enrichedFiles.reduce((sum, file) => sum + file.deletions, 0),
    };
  }
  const files = new Map();
  for (const item of normalizedEvents) {
    if (item.activityType !== 'file' || ['failed', 'cancelled', 'blocked'].includes(String(item.status || ''))) continue;
    const changes = Array.isArray(item.changes) ? item.changes : [];
    for (const change of changes) {
      if (['failed', 'cancelled', 'blocked'].includes(String(change?.status || ''))) continue;
      const path = displayFilePath(change, item);
      if (!path) continue;
      const key = path.toLowerCase();
      if (!files.has(key)) files.set(key, {
        path,
        kind: changeOperation(change, item),
        label: changeKindLabel(changeOperation(change, item)),
        additions: 0,
        deletions: 0,
        binary: false,
        createdContentMetric: null,
        diffs: [],
        diffSet: new Set(),
      });
      mergeFileChange(files.get(key), change, item);
    }
  }
  const items = [...files.values()].map((file, index) => ({
    ...file,
    id: `file-${index}`,
    diff: file.diffs.join('\n'),
    diffSet: undefined,
    diffs: undefined,
  }));
  return {
    files: items,
    additions: items.reduce((sum, file) => sum + file.additions, 0),
    deletions: items.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function diffStatsMarkup(file = {}) {
  if (!file.additions && !file.deletions) {
    if (file.createdContentMetric?.label) return '<span class="codex-change-content-stat">' + escapeHtml(file.createdContentMetric.label) + '</span>';
    return '<span class="codex-change-binary-stat">\u5df2\u66f4\u65b0</span>';
  }
  return '<span class="codex-change-additions">+' + file.additions + '</span><span class="codex-change-deletions">-' + file.deletions + '</span>';
}

function modelStatsMarkup(model = {}) {
  const lineStats = model.additions || model.deletions
    ? '<span class="codex-change-additions">+' + model.additions + '</span><span class="codex-change-deletions">-' + model.deletions + '</span>'
    : '';
  const metrics = (model.files || [])
    .filter((file) => !file.additions && !file.deletions && file.createdContentMetric)
    .map((file) => file.createdContentMetric);
  let contentSummary = '';
  if (metrics.length === 1) contentSummary = metrics[0].summary || metrics[0].label;
  else if (metrics.length) {
    const units = new Set(metrics.map((metric) => metric.unit).filter(Boolean));
    contentSummary = units.size === 1 && metrics.every((metric) => Number.isFinite(metric.value))
      ? '\u65b0\u589e ' + metrics.reduce((sum, metric) => sum + metric.value, 0) + ' ' + metrics[0].unit
      : metrics.map((metric) => metric.summary || metric.label).join('\uff1b');
  }
  if (!lineStats && !contentSummary) return '<span class="codex-change-binary-stat">\u5df2\u66f4\u65b0</span>';
  return lineStats
    + (lineStats && contentSummary ? '<span class="codex-change-stat-divider">\u00b7</span>' : '')
    + (contentSummary ? '<span class="codex-change-content-stat">' + escapeHtml(contentSummary) + '</span>' : '');
}

function diffLineMarkup(line = {}, compact = false) {
  const marker = line.type === 'add' ? '+' : line.type === 'delete' ? '−' : '';
  return `<div class="codex-review-diff-line is-${escapeAttr(line.type || 'context')}${compact ? ' is-compact' : ''}">
    <span class="codex-review-diff-old">${escapeHtml(String(line.oldNumber ?? ''))}</span>
    <span class="codex-review-diff-new">${escapeHtml(String(line.newNumber ?? ''))}</span>
    <b aria-hidden="true">${marker}</b><code>${escapeHtml(String(line.text ?? '')) || ' '}</code>
  </div>`;
}

function contextSummaryMarkup(count = 0) {
  const label = `${count} unmodified ${count === 1 ? 'line' : 'lines'}`;
  return `<div class="codex-review-context-summary"><span>${escapeHtml(label)}</span></div>`;
}

function renderedDiffLines(lines = [], { compact = false } = {}) {
  const visible = lines.filter((line) => !['meta', 'hunk'].includes(line.type));
  if (compact) return visible.map((line) => diffLineMarkup(line, true)).join('');
  const output = [];
  let contextCount = 0;
  const flushContext = () => {
    if (!contextCount) return;
    output.push(contextSummaryMarkup(contextCount));
    contextCount = 0;
  };
  for (const line of visible) {
    if (line.type === 'context') {
      contextCount += 1;
      continue;
    }
    flushContext();
    output.push(diffLineMarkup(line, false));
  }
  flushContext();
  return output.join('');
}

function renderDiff(file = {}, { compact = false } = {}) {
  const parsed = parseDiff(file.diff, { operation: file.kind });
  if (parsed.binary || file.binary) return '<p class="codex-review-empty">这是二进制文件变更，无法逐行显示文本差异。</p>';
  if (!parsed.lines.length) return '<p class="codex-review-empty">本轮记录了文件变更，但上游没有提供可显示的逐行差异。</p>';
  const limit = compact ? HOVER_DIFF_LINE_LIMIT : REVIEW_DIFF_LINE_LIMIT;
  const lines = parsed.lines.slice(0, limit);
  return `<div class="codex-review-diff-lines">${renderedDiffLines(lines, { compact })}</div>${parsed.lines.length > limit ? `<p class="codex-review-truncated">其余 ${parsed.lines.length - limit} 行已折叠</p>` : ''}`;
}

function renderHoverPreview(file = {}) {
  return `<div class="codex-change-hover-preview" role="tooltip">
    <div class="codex-change-hover-head"><strong>${escapeHtml(file.path)}</strong><span>${diffStatsMarkup(file)}</span></div>
    <div class="codex-change-hover-legend"><span class="is-add">+ 新增</span><span class="is-delete">− 删除</span><small>灰色为未修改上下文</small></div>
    <div class="codex-change-hover-diff">${renderDiff(file, { compact: true })}</div>
  </div>`;
}

function renderSummaryFileRow(file = {}, dialogId = '') {
  return `<div class="codex-change-summary-row">
    <button type="button" data-codex-review-open="${escapeAttr(dialogId)}" data-codex-review-target="${escapeAttr(file.id)}">
      <span class="codex-change-file-icon" aria-hidden="true">#</span>
      <span class="codex-change-file-path">${escapeHtml(file.path)}</span>
      <span class="codex-change-file-stats">${diffStatsMarkup(file)}</span>
    </button>
    ${renderHoverPreview(file)}
  </div>`;
}

function renderReviewFile(file = {}, { open = false } = {}) {
  return `<details class="codex-review-file${open ? ' is-active' : ''}" data-codex-review-panel="${escapeAttr(file.id)}"${open ? ' open' : ''}>
    <summary data-codex-review-select="${escapeAttr(file.id)}">
      <span class="codex-change-file-icon" aria-hidden="true">#</span>
      <span class="codex-review-file-path">${escapeHtml(file.path)}</span>
      <small>${diffStatsMarkup(file)}</small>
      <i aria-hidden="true">⌄</i>
    </summary>
    <div class="codex-review-file-diff">
      <div class="codex-review-diff-scroll">${renderDiff(file)}</div>
    </div>
  </details>`;
}

function renderReviewDialog(model = {}, messageId = '') {
  const firstId = model.files[0]?.id || '';
  return `<dialog class="codex-review-dialog" data-codex-review-dialog data-codex-review-message-id="${escapeAttr(messageId)}">
    <div class="codex-review-resizer" data-codex-review-resizer role="separator" aria-label="调整审阅区域宽度" aria-orientation="vertical" aria-valuemin="420" aria-valuemax="900" aria-valuenow="640" tabindex="0"></div>
    <section class="codex-review-shell">
      <header class="codex-review-header">
        <span class="codex-review-tab"><span class="codex-review-tab-icon">▣</span><span><strong>审阅</strong><small>上一轮 · ${modelStatsMarkup(model)}</small></span></span>
        <button type="button" data-codex-review-close aria-label="关闭审阅">×</button>
      </header>
      <div class="codex-review-overview">
        <span><strong>上一轮</strong><small>${model.files.length} 个文件</small></span>
        <span>${modelStatsMarkup(model)}</span>
        <code data-codex-review-current>${escapeHtml(model.files[0]?.path || '')}</code>
      </div>
      <main class="codex-review-file-list" data-codex-review-files aria-label="本轮变更文件">
        ${model.files.map((file) => renderReviewFile(file, { open: file.id === firstId })).join('')}
      </main>
    </section>
  </dialog>`;
}

export function renderCodexChangeSummary(events = [], { messageId = '' } = {}) {
  const model = codexTurnChangeModel(events);
  if (!model.files.length) return '';
  const safeMessageId = safeText(messageId).replace(/[^a-zA-Z0-9_-]/g, '-') || 'assistant';
  const dialogId = `codex-review-template-${safeMessageId}`;
  const visible = model.files.slice(0, SUMMARY_VISIBLE_FILE_COUNT);
  const hidden = model.files.slice(SUMMARY_VISIBLE_FILE_COUNT);
  return `<section class="codex-change-summary" aria-label="本轮文件变更">
    <header>
      <span class="codex-change-summary-icon" aria-hidden="true">▣</span>
      <span class="codex-change-summary-title"><strong>${escapeHtml(`\u5df2\u7f16\u8f91 ${model.files.length} \u4e2a\u6587\u4ef6`)}</strong><small>${modelStatsMarkup(model)}</small></span>
      <button class="codex-change-review-button" type="button" data-codex-review-open="${escapeAttr(dialogId)}">审阅</button>
    </header>
    <div class="codex-change-summary-files">${visible.map((file) => renderSummaryFileRow(file, dialogId)).join('')}</div>
    ${hidden.length ? `<details class="codex-change-summary-more"><summary>再显示 ${hidden.length} 个文件 <span>⌄</span></summary><div>${hidden.map((file) => renderSummaryFileRow(file, dialogId)).join('')}</div></details>` : ''}
    <template id="${escapeAttr(dialogId)}" data-codex-review-template>${renderReviewDialog(model, messageId)}</template>
  </section>`;
}
