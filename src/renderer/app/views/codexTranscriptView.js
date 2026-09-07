import { clipInline, escapeAttr, escapeHtml, janusBrandText } from '../utils/format.js';
import { filePayloadAttr } from '../utils/filePayload.js';

const CODEX_ACTIVITY_TYPES = new Set([
  'reasoning', 'commentary', 'command', 'file', 'tool', 'search', 'agent', 'image',
  'warning', 'error', 'review', 'context', 'plan', 'model', 'sandbox', 'wait', 'approval',
]);
const TECHNICAL_ACTIVITY_TYPES = new Set(['protocol', 'usage', 'answer', 'progress', 'heartbeat', 'routing']);
const NECESSARY_JANUS_STATUSES = new Set(['waiting', 'failed', 'cancelled', 'blocked']);
const GENERIC_STATUS_METHODS = new Set(['thread/status/changed', 'turn/started', 'turn/completed']);
const DIFF_INITIAL_LINE_LIMIT = 240;
const DIFF_RENDER_LINE_LIMIT = 2000;
const DIFF_PARSE_CHAR_LIMIT = 600_000;

function safeText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text === '[object Object]' ? '' : text;
}

function eventOrigin(item = {}) {
  const explicit = safeText(item.eventOrigin);
  if (explicit) return explicit;
  if (/^codex_/.test(safeText(item.nativeSource))) return 'codex';
  if (Array.isArray(item.protocolEvents) && item.protocolEvents.length) return 'codex';
  const activityId = String(item.activityId || '');
  if (/^(?:progress|planning|direct)-/.test(activityId)) return 'janus';
  return CODEX_ACTIVITY_TYPES.has(String(item.activityType || '')) ? 'codex' : 'janus';
}

function normalizedEvent(item = {}) {
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? item.payload : {};
  return {
    ...item,
    ...payload,
    activityId: String(payload.activityId || item.activityId || item.id || ''),
    activityType: String(payload.activityType || item.activityType || ''),
    eventOrigin: String(payload.eventOrigin || item.eventOrigin || ''),
    status: String(payload.status || item.status || 'completed'),
    title: janusBrandText(safeText(payload.title) || safeText(item.title)),
    detail: janusBrandText(safeText(payload.detail) || safeText(item.detail) || safeText(item.summary)),
    toolServer: janusBrandText(safeText(payload.toolServer) || safeText(item.toolServer) || safeText(item.server)),
    toolName: janusBrandText(safeText(payload.toolName) || safeText(item.toolName)),
    command: safeText(item.command) || safeText(payload.command),
    output: typeof item.output === 'string' ? item.output : typeof payload.output === 'string' ? payload.output : '',
    summaryParts: Array.isArray(payload.summaryParts) ? payload.summaryParts : Array.isArray(item.summaryParts) ? item.summaryParts : [],
    stageOutput: Boolean(payload.stageOutput || item.stageOutput),
    nativeSource: safeText(payload.nativeSource) || safeText(item.nativeSource),
    actorId: String(item.agentId || item.actorId || payload.agentId || ''),
  };
}

function isGenericProtocolStatus(item = {}) {
  if (item.activityType !== 'status') return false;
  const methods = (item.protocolEvents || []).map((event) => String(event?.method || ''));
  return methods.some((method) => GENERIC_STATUS_METHODS.has(method))
    || /Codex\s*(?:线程|本轮|轮次)/.test(item.title || '');
}

function isTechnicalActivity(item = {}) {
  return TECHNICAL_ACTIVITY_TYPES.has(item.activityType) || isGenericProtocolStatus(item);
}

function isUBuddyTaskPublishStatus(item = {}) {
  return item.activityType === 'status'
    && String(item.activityId || '').startsWith('ubuddy-task-publish:');
}

function visibleEvent(item = {}) {
  if (!item.activityType || isTechnicalActivity(item)) return false;
  if (isUBuddyTaskPublishStatus(item)) return true;
  if (eventOrigin(item) === 'codex') {
    if (item.activityType === 'sandbox' && item.status === 'completed') return false;
    return CODEX_ACTIVITY_TYPES.has(item.activityType);
  }
  return NECESSARY_JANUS_STATUSES.has(item.status);
}

function transcriptBlocks(events = []) {
  const blocks = [];
  let activeGroup = null;
  let activeBatch = null;

  const appendOperationBlock = (target, item) => {
    if (item.activityType === 'command') {
      if (!activeGroup || activeGroup.type !== 'commands' || activeGroup.target !== target) {
        activeGroup = { type: 'commands', items: [], target };
        target.push(activeGroup);
      }
      activeGroup.items.push(item);
      return;
    }
    if (item.activityType === 'tool' || item.activityType === 'search') {
      const groupKey = `${item.activityType}:${toolProviderLabel(item)}`;
      if (!activeGroup || activeGroup.type !== 'tools' || activeGroup.key !== groupKey || activeGroup.target !== target) {
        activeGroup = { type: 'tools', key: groupKey, items: [], target };
        target.push(activeGroup);
      }
      activeGroup.items.push(item);
      return;
    }
    if (item.activityType === 'file') {
      if (!activeGroup || activeGroup.type !== 'files' || activeGroup.target !== target) {
        activeGroup = { type: 'files', items: [], target };
        target.push(activeGroup);
      }
      activeGroup.items.push(item);
      return;
    }
    activeGroup = null;
    target.push({ type: 'event', item });
  };

  for (const item of events) {
    if (!visibleEvent(item)) continue;
    if (item.activityType === 'reasoning' || item.activityType === 'commentary') {
      activeGroup = null;
      activeBatch = { type: 'batch', narrative: item, blocks: [] };
      blocks.push(activeBatch);
      continue;
    }
    if (item.eventOrigin === 'janus' || eventOrigin(item) === 'janus') {
      activeBatch = null;
      activeGroup = null;
    }
    appendOperationBlock(activeBatch?.blocks || blocks, item);
  }
  for (const block of blocks) {
    if (block.type === 'batch') block.blocks.forEach((child) => { delete child.target; });
    else delete block.target;
  }
  return blocks;
}

function actorMarkup(item = {}, actorLabelForEvent = null) {
  const label = typeof actorLabelForEvent === 'function' ? String(actorLabelForEvent(item) || '') : '';
  return label ? `<small class="codex-transcript-actor">${escapeHtml(label)}</small>` : '';
}

function reasoningParts(item = {}) {
  const detail = safeText(item.detail);
  const summaryParts = (Array.isArray(item.summaryParts) ? item.summaryParts : [])
    .map((part) => safeText(typeof part === 'string' ? part : part?.text))
    .filter(Boolean);
  const reasoningText = safeText(item.reasoningText);
  return [...new Set([
    ...(summaryParts.length ? summaryParts : detail ? [detail] : []),
    reasoningText,
  ].filter(Boolean))];
}

function renderNarrative(item = {}, actorLabelForEvent = null, { active = false } = {}) {
  const parts = reasoningParts(item);
  if (!parts.length) return '';
  return `<div class="codex-transcript-narrative type-${escapeAttr(item.activityType)} is-${escapeAttr(item.status)}${active ? ' is-active-action' : ''}">
    ${actorMarkup(item, actorLabelForEvent)}
    ${item.activityType === 'reasoning' ? '<div class="codex-transcript-label">思考</div>' : ''}
    ${parts.map((part) => `<p>${escapeHtml(part).replaceAll('\n', '<br>')}</p>`).join('')}
  </div>`;
}

function commandStatus(item = {}) {
  const failed = item.status === 'failed' || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
  if (failed) return 'failed';
  if (item.status === 'cancelled') return 'cancelled';
  if (item.status === 'running' || item.status === 'waiting') return 'running';
  return 'completed';
}

function unwrapShellCommand(command = '') {
  const text = safeText(command);
  const match = text.match(/^\/(?:usr\/)?bin\/(?:ba|z|fi)?sh\s+-lc\s+(["'])([\s\S]*)\1$/);
  return match ? match[2].replaceAll('\\"', '"') : text;
}

function humanCommand(item = {}) {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const commands = [...new Set(actions.map((action) => safeText(action?.command)).filter(Boolean))];
  if (commands.length === 1) return commands[0];
  return unwrapShellCommand(item.command || item.detail || '');
}

function commandPreview(item = {}) {
  return clipInline((humanCommand(item) || '命令').split('\n')[0], 120);
}

function commandGroupLabel(items = []) {
  const statuses = items.map(commandStatus);
  if (statuses.includes('running')) return items.length > 1 ? '正在运行多个命令' : '正在运行命令';
  if (statuses.every((status) => status === 'cancelled')) return '命令执行已取消';
  return items.length > 1 ? '运行了多个命令' : '运行了 1 个命令';
}

function toolProviderLabel(item = {}) {
  const raw = safeText(item.toolServer) || safeText(item.server) || safeText(item.title);
  if (item.activityType === 'search' || /browser|chrome|playwright|web(?:[_ -]?search)?/i.test(raw)) return '浏览器';
  return raw || '工具';
}

function toolGroupLabel(items = []) {
  const provider = toolProviderLabel(items[0]);
  const running = items.some((item) => ['running', 'waiting'].includes(String(item.status || '')));
  const failed = items.some((item) => String(item.status || '') === 'failed');
  if (running) return `正在使用 ${provider}`;
  if (failed) return `已使用 ${provider}，部分操作未成功`;
  return items.length > 1 ? `已使用 ${provider}运行了多个操作` : `已使用 ${provider}`;
}

function commandResultLabel(item = {}) {
  const status = commandStatus(item);
  return ({ running: '正在运行', completed: '成功', failed: '失败', cancelled: '已取消' })[status] || '已完成';
}

function renderCommand(item = {}, { messageId = '', actorLabelForEvent = null, direct = false } = {}) {
  const command = humanCommand(item);
  const rawCommand = safeText(item.command) || command;
  const status = commandStatus(item);
  const duration = Number.isFinite(item.durationMs) && item.durationMs > 0 ? `${Math.max(1, Math.round(item.durationMs / 1000))}s` : '';
  const meta = [item.cwd, duration, Number.isInteger(item.exitCode) ? `退出码 ${item.exitCode}` : ''].filter(Boolean).join(' · ');
  const toggleId = `${messageId}::${item.activityId}`;
  const head = `
      <span><b>${status === 'running' ? '正在运行' : status === 'failed' ? '运行未成功' : status === 'cancelled' ? '已取消' : '已运行'}</b><code>${escapeHtml(commandPreview(item))}</code></span>
      ${actorMarkup(item, actorLabelForEvent)}`;
  const body = `<div class="codex-shell-card">
      <div class="codex-shell-title">Shell</div>
      ${rawCommand ? `<pre class="codex-shell-command"><code>$ ${escapeHtml(rawCommand)}</code></pre>` : ''}
      ${item.terminalInput ? `<pre class="codex-shell-input"><code>${escapeHtml(String(item.terminalInput))}</code></pre>` : ''}
      ${item.output ? `<pre class="codex-shell-output"><code>${escapeHtml(String(item.output))}</code></pre>` : '<p class="codex-shell-empty">命令没有产生输出。</p>'}
      <footer><span>${escapeHtml(meta)}</span><strong class="is-${escapeAttr(status)}">${escapeHtml(commandResultLabel(item))}</strong></footer>
    </div>`;
  if (direct) return `<div class="codex-command-item is-${escapeAttr(status)} is-direct">
    <div class="codex-command-item-head">${head}</div>
    ${body}
  </div>`;
  return `<details class="codex-command-item is-${escapeAttr(status)}" data-codex-command-toggle="${escapeAttr(toggleId)}"${item.expanded === true ? ' open' : ''}>
    <summary class="codex-command-item-head">${head}</summary>
    ${body}
  </details>`;
}

function renderCommandGroup(items = [], options = {}) {
  if (!items.length) return '';
  if (items.length === 1) {
    return `<div class="codex-single-command">${renderCommand(items[0], options)}</div>`;
  }
  const first = items[0];
  const statuses = items.map(commandStatus);
  const state = statuses.includes('running')
    ? 'running'
    : statuses.every((status) => status === 'cancelled')
      ? 'cancelled'
      : statuses.every((status) => status === 'failed')
        ? 'failed'
        : 'completed';
  const toggleId = `${options.messageId || ''}::${first.activityId}`;
  return `<details class="codex-command-group is-${escapeAttr(state)}" data-codex-command-group-toggle="${escapeAttr(toggleId)}"${first.commandGroupExpanded === true ? ' open' : ''}>
    <summary class="codex-command-group-head"><span class="codex-command-icon">⌘</span><strong>${escapeHtml(commandGroupLabel(items))}</strong><small>${items.length}</small></summary>
    <div class="codex-command-list">${items.map((item) => renderCommand(item, { ...options, direct: false })).join('')}</div>
  </details>`;
}

function renderToolGroup(items = [], options = {}) {
  if (!items.length) return '';
  const first = items[0];
  const running = items.some((item) => ['running', 'waiting'].includes(String(item.status || '')));
  const failed = items.some((item) => String(item.status || '') === 'failed');
  const state = running ? 'running' : failed ? 'failed' : 'completed';
  const toggleId = `${options.messageId || ''}::${first.activityId}`;
  return `<details class="codex-command-group codex-tool-group is-${escapeAttr(state)}" data-codex-command-group-toggle="${escapeAttr(toggleId)}"${first.commandGroupExpanded === true ? ' open' : ''}>
    <summary class="codex-command-group-head"><span class="codex-command-icon">↗</span><strong>${escapeHtml(toolGroupLabel(items))}</strong><small>${items.length}</small></summary>
    <div class="codex-command-list">${items.map((item) => renderOperation(item, options)).join('')}</div>
  </details>`;
}

function prettyValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function humanPath(value = '') {
  const path = safeText(value).replaceAll('\\', '/');
  if (!path) return '';
  for (const marker of ['/workspace/', '/repo/']) {
    const index = path.lastIndexOf(marker);
    if (index >= 0) return path.slice(index + marker.length);
  }
  const projectPart = path.match(/\/(src|scripts|assets|docs|test|tests|cloud|network)\/.+$/);
  return projectPart ? projectPart[0].slice(1) : path.split('/').filter(Boolean).at(-1) || path;
}

function relativeFilePath(value = '', workspaceRoot = '') {
  const path = safeText(value).replaceAll('\\', '/');
  const root = safeText(workspaceRoot).replaceAll('\\', '/').replace(/\/+$/, '');
  if (path && root && (path.toLowerCase() === root.toLowerCase() || path.toLowerCase().startsWith(`${root.toLowerCase()}/`))) {
    return path.slice(root.length).replace(/^\/+/, '') || path.split('/').filter(Boolean).at(-1) || path;
  }
  return humanPath(path);
}

function fileChangeKind(value) {
  const kind = safeText(value).toLowerCase();
  return ({
    add: '新增', create: '新增', added: '新增',
    update: '修改', modify: '修改', modified: '修改',
    delete: '删除', deleted: '删除', remove: '删除', removed: '删除',
    move: '移动', moved: '移动', rename: '移动', renamed: '移动',
  })[kind] || '修改';
}

function fileExtension(value = '') {
  const path = safeText(value).replaceAll('\\', '/');
  const basename = path.split('/').at(-1) || '';
  const index = basename.lastIndexOf('.');
  return index > 0 ? basename.slice(index + 1).toLowerCase() : '';
}

function fileChangeTargetPath(change = {}) {
  return safeText(change.movePath) || safeText(change.path);
}

function fileChangeDisplayPath(change = {}, workspaceRoot = '', { target = false } = {}) {
  if (target) return safeText(change.moveRelativePath) || relativeFilePath(change.movePath || change.path, workspaceRoot) || safeText(change.relativePath);
  return safeText(change.relativePath) || relativeFilePath(change.path, workspaceRoot);
}

function fileStatusLabel(value = '') {
  return ({
    waiting: '等待批准', running: '处理中', failed: '修改失败', cancelled: '已取消', blocked: '已阻止',
  })[String(value || '').toLowerCase()] || '';
}

function fileOperationLabel(item = {}) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const status = String(item.status || '').toLowerCase();
  if (status === 'waiting') return '文件修改等待批准';
  if (status === 'failed') return '文件修改失败';
  if (status === 'cancelled') return '文件修改已取消';
  if (status === 'blocked') return '文件修改已阻止';
  if (status === 'running') return changes.length === 1 ? `正在${fileChangeKind(changes[0]?.kind)}` : '正在处理文件';
  if (changes.length === 1) return `${fileChangeKind(changes[0]?.kind)}了`;
  return '文件变更';
}

function fileSemanticType(change = {}) {
  const ext = fileExtension(fileChangeTargetPath(change) || change.moveRelativePath || change.relativePath);
  if (['doc', 'docx'].includes(ext)) return { key: 'word', label: 'Word 文档', content: '标题、段落、列表和表格' };
  if (ext === 'pptx') return { key: 'presentation', label: '演示文稿', content: '幻灯片、页面文本和版式内容' };
  if (ext === 'pdf') return { key: 'pdf', label: 'PDF 文档', content: '页面和提取文本' };
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(ext)) return { key: 'spreadsheet', label: '表格文档', content: '工作表和单元格文本' };
  if (['md', 'markdown', 'mdx', 'rst', 'tex'].includes(ext)) return { key: 'markdown', label: '文本型文档', content: '正文行' };
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) return { key: 'image', label: '图片资源', content: '当前图像' };
  return null;
}

function fileSemanticDescription(change = {}, status = '', parsed = {}) {
  const semantic = fileSemanticType(change);
  if (!semantic && !parsed.binary) return null;
  const label = semantic?.label || '二进制文件';
  const content = semantic?.content || '当前文件';
  const action = fileChangeKind(change?.kind);
  const normalizedStatus = String(status || '').toLowerCase();
  if (change?.comparison?.strict === true) {
    return { label, text: `已使用 turn 开始时的本地基线建立严格前后对照；下方可查看${content}变化。` };
  }
  if (normalizedStatus === 'waiting') return { label, text: `${action}操作正在等待批准；预览展示当前磁盘版本。` };
  if (normalizedStatus === 'failed') return { label, text: `${action}操作未成功；可以检查当前磁盘版本。` };
  if (normalizedStatus === 'cancelled' || normalizedStatus === 'blocked') return { label, text: `${action}操作没有应用；可以检查当前磁盘版本。` };
  if (action === '删除') return { label, text: `文件已删除。原生事件未携带可读取的旧版本${content}。` };
  if (action === '移动' && !safeText(change.diff)) return { label, text: `文件已移动到新位置，当前事件没有报告内容变化。` };
  if (semantic?.key === 'markdown' && !parsed.binary) return { label, text: '原生文本差异已按正文行展示。' };
  if (semantic?.key === 'image') return { label, text: `可预览${content}；原生事件没有提供修改前的图像快照。` };
  if (parsed.binary || ['word', 'presentation', 'pdf', 'spreadsheet'].includes(semantic?.key)) {
    return { label, text: `二进制格式不适合逐行比较，可预览当前版本的${content}。` };
  }
  return { label, text: `可预览当前版本的${content}。` };
}

function fileActionPayload(change = {}, workspaceRoot = '') {
  const targetPath = fileChangeTargetPath(change);
  const displayPath = fileChangeDisplayPath(change, workspaceRoot, { target: Boolean(change.movePath || change.moveRelativePath) });
  const ext = fileExtension(targetPath);
  const kind = ['doc', 'docx', 'pptx', 'pdf', 'xls', 'xlsx'].includes(ext) ? ext : '';
  return filePayloadAttr({
    name: targetPath.replaceAll('\\', '/').split('/').at(-1) || displayPath || 'file',
    filename: targetPath.replaceAll('\\', '/').split('/').at(-1) || displayPath || 'file',
    path: targetPath,
    relative_path: displayPath,
    kind,
  });
}

function filePreviewLabel(change = {}) {
  const semantic = fileSemanticType(change);
  if (semantic?.key === 'image') return '预览当前图片';
  if (semantic) return '预览当前文档';
  return '预览当前文件';
}

function renderFileActions(change = {}, { enableFileActions = true, workspaceRoot = '' } = {}) {
  const action = fileChangeKind(change?.kind);
  const targetPath = fileChangeTargetPath(change);
  const displayPath = fileChangeDisplayPath(change, workspaceRoot, { target: Boolean(change.movePath || change.moveRelativePath) });
  if (!displayPath) return '';
  if (!enableFileActions) return '';
  const copyButton = `<button type="button" data-copy-file-path="${escapeAttr(displayPath)}" data-codex-file-action>复制路径</button>`;
  if (!targetPath || action === '删除') return `<div class="codex-file-change-actions">${copyButton}</div>`;
  const payload = fileActionPayload(change, workspaceRoot);
  return `<div class="codex-file-change-actions">
    <button type="button" data-preview-file="${payload}" data-codex-file-action>${escapeHtml(filePreviewLabel(change))}</button>
    <button type="button" data-open-file="${payload}" data-codex-file-action>打开</button>
    <button type="button" data-show-file="${payload}" data-codex-file-action>定位</button>
    ${copyButton}
  </div>`;
}

function comparisonReasonLabel(value = '') {
  return ({
    waiting_for_completed_file_state: '等待文件操作完成后生成严格对照。',
    baseline_scan_incomplete: 'turn 开始时的基线扫描达到安全上限，未捕获此文件。',
    file_missing_from_turn_baseline: 'turn 开始时文件不存在，无法建立修改前版本。',
    deleted_file_missing_from_baseline: '删除前版本没有进入 turn 基线。',
    updated_file_missing_after_turn: '操作完成后没有找到文件。',
    added_file_missing_after_turn: '新增操作完成后没有找到文件。',
    move_source_missing_from_baseline: '移动前的源文件没有进入 turn 基线。',
    move_target_missing_after_turn: '移动完成后没有找到目标文件。',
    snapshot_size_limit: '文件超过本地严格快照的安全容量限制。',
    pdf_text_extraction_unavailable: 'PDF 正文提取器不可用，仍保留文件哈希与前后快照。',
    semantic_extraction_failed: '文档结构提取失败，仍保留完整文件哈希与前后快照。',
    baseline_scan_read_failed: 'turn 基线扫描无法读取部分目录。',
    baseline_copy_failed: 'turn 基线中的部分文件无法复制。',
    baseline_scan_failed: 'turn 基线扫描没有成功完成。',
  })[safeText(value)] || safeText(value) || '没有足够数据生成严格前后对照。';
}

function comparisonMetrics(metrics = {}, kind = '') {
  if (!metrics || typeof metrics !== 'object') return '';
  if (kind === 'docx') return [
    Number.isFinite(metrics.headings) ? `标题 ${metrics.headings}` : '',
    Number.isFinite(metrics.paragraphs) ? `段落 ${metrics.paragraphs}` : '',
    Number.isFinite(metrics.lists) ? `列表 ${metrics.lists}` : '',
    Number.isFinite(metrics.tables) ? `表格 ${metrics.tables}` : '',
  ].filter(Boolean).join(' · ');
  if (kind === 'pptx') return Number.isFinite(metrics.slides) ? `幻灯片 ${metrics.slides}` : '';
  if (kind === 'image') return [
    metrics.width && metrics.height ? `${metrics.width} × ${metrics.height}` : '',
    Number.isFinite(metrics.bytes) ? `${Math.max(1, Math.round(metrics.bytes / 1024))} KB` : '',
  ].filter(Boolean).join(' · ');
  return [
    Number.isFinite(metrics.lines) ? `内容行 ${metrics.lines}` : '',
    Number.isFinite(metrics.characters) ? `字符 ${metrics.characters}` : '',
  ].filter(Boolean).join(' · ');
}

function comparisonSnapshotAction(side = {}, label = '', { enableFileActions = true } = {}) {
  const snapshot = side?.snapshot && typeof side.snapshot === 'object' ? side.snapshot : {};
  if (!enableFileActions || !snapshot.path) return '';
  const payload = filePayloadAttr({
    path: snapshot.path,
    name: snapshot.name || snapshot.filename || 'snapshot',
    filename: snapshot.filename || snapshot.name || 'snapshot',
  });
  return `<button type="button" data-preview-file="${payload}" data-codex-file-action>${escapeHtml(label)}</button>`;
}

function renderSemanticComparisonUnits(units = [], type = 'add') {
  if (!Array.isArray(units) || !units.length) return '';
  const symbol = type === 'delete' ? '−' : '+';
  return units.map((unit) => `<div class="codex-semantic-diff-line is-${escapeAttr(type)}">
    <b>${symbol}</b><small>${escapeHtml(unit?.label || unit?.type || '')}</small><span>${escapeHtml(unit?.text || '')}</span>
  </div>`).join('');
}

function renderStrictComparison(change = {}, options = {}) {
  const comparison = change?.comparison && typeof change.comparison === 'object' ? change.comparison : null;
  if (!comparison) return '';
  if (comparison.status === 'pending') {
    return `<div class="codex-strict-comparison is-pending">
      <header><strong>严格前后对照</strong><span>等待完成</span></header>
      <p>${escapeHtml(comparisonReasonLabel(comparison.reason))}${comparison.baselineCaptured ? ' 修改前基线已捕获。' : ''}</p>
      <small>变更来源：Janus 原生运行事件 · 对照来源：Janus turn 开始快照</small>
    </div>`;
  }
  if (comparison.status !== 'complete' || comparison.strict !== true) {
    return `<div class="codex-strict-comparison is-unavailable">
      <header><strong>严格前后对照</strong><span>数据不完整</span></header>
      <p>${escapeHtml(comparisonReasonLabel(comparison.reason))}</p>
      <small>系统不会用推测内容代替缺失的修改前版本。</small>
    </div>`;
  }
  const kind = safeText(comparison.kind) || fileExtension(fileChangeTargetPath(change));
  const beforeMetrics = comparisonMetrics(comparison.semantic?.beforeMetrics, kind);
  const afterMetrics = comparisonMetrics(comparison.semantic?.afterMetrics, kind);
  const beforeHash = safeText(comparison.before?.sha256).slice(0, 12);
  const afterHash = safeText(comparison.after?.sha256).slice(0, 12);
  const removed = renderSemanticComparisonUnits(comparison.semantic?.removed, 'delete');
  const added = renderSemanticComparisonUnits(comparison.semantic?.added, 'add');
  const beforeAction = comparisonSnapshotAction(comparison.before, '预览修改前', options);
  const afterAction = comparisonSnapshotAction(comparison.after, '预览修改后', options);
  return `<div class="codex-strict-comparison is-complete">
    <header><strong>严格前后对照</strong><span>SHA-256 已校验</span></header>
    ${(beforeMetrics || afterMetrics) ? `<div class="codex-comparison-metrics"><span><small>修改前</small>${escapeHtml(beforeMetrics || '无内容')}</span><b>→</b><span><small>修改后</small>${escapeHtml(afterMetrics || '无内容')}</span></div>` : ''}
    ${(removed || added) ? `<div class="codex-semantic-diff">${removed}${added}</div>` : '<p>文件版本已严格校验，未提取到可逐项展示的文本结构变化。</p>'}
    ${comparison.semantic?.reason ? `<p class="codex-comparison-warning">${escapeHtml(comparisonReasonLabel(comparison.semantic.reason))}</p>` : ''}
    ${comparison.semantic?.truncated ? '<p class="codex-comparison-warning">文档较长，前后文件哈希是完整的，但语义条目仅展示部分变化。</p>' : ''}
    <footer>
      <span>${beforeHash ? `前 ${escapeHtml(beforeHash)}` : '修改前不存在'}${afterHash ? ` · 后 ${escapeHtml(afterHash)}` : ' · 修改后不存在'}</span>
      ${(beforeAction || afterAction) ? `<div>${beforeAction}${afterAction}</div>` : '<em>本地快照在此设备上不可用，仅保留语义对照和哈希。</em>'}
    </footer>
    <small>变更来源：Janus 原生运行事件 · 对照来源：Janus turn 开始快照</small>
  </div>`;
}

function diffLineType(line = '', inHunk = false) {
  if (/^@@\s/.test(line)) return 'hunk';
  if (/^(?:diff --git|index |new file mode |deleted file mode |similarity index |rename from |rename to |old mode |new mode )/.test(line)) return 'meta';
  if (!inHunk && /^(?:--- |\+\+\+ )/.test(line)) return 'meta';
  if (/^\\ No newline at end of file/.test(line)) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'delete';
  return 'context';
}

function parseUnifiedDiff(value = '') {
  const source = String(value ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const binary = /(?:^|\n)(?:GIT binary patch|Binary files .+ differ)(?:\n|$)/i.test(source);
  if (!source || binary) return { additions: 0, deletions: 0, binary, lines: [], truncated: false };

  const truncatedBySize = source.length > DIFF_PARSE_CHAR_LIMIT;
  const clippedSource = truncatedBySize ? source.slice(0, DIFF_PARSE_CHAR_LIMIT) : source;
  const rawLines = clippedSource.split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  let oldLine = null;
  let newLine = null;
  let additions = 0;
  let deletions = 0;
  const lines = rawLines.map((text) => {
    const type = diffLineType(text, Number.isInteger(oldLine) || Number.isInteger(newLine));
    if (type === 'hunk') {
      const match = text.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      return { type, oldNumber: '', newNumber: '', text };
    }
    if (type === 'meta' && /^diff --git/.test(text)) {
      oldLine = null;
      newLine = null;
    }
    if (type === 'add') {
      const line = { type, oldNumber: '', newNumber: Number.isInteger(newLine) ? newLine : '', text };
      if (Number.isInteger(newLine)) newLine += 1;
      additions += 1;
      return line;
    }
    if (type === 'delete') {
      const line = { type, oldNumber: Number.isInteger(oldLine) ? oldLine : '', newNumber: '', text };
      if (Number.isInteger(oldLine)) oldLine += 1;
      deletions += 1;
      return line;
    }
    if (type === 'context' && (Number.isInteger(oldLine) || Number.isInteger(newLine))) {
      const line = {
        type,
        oldNumber: Number.isInteger(oldLine) ? oldLine : '',
        newNumber: Number.isInteger(newLine) ? newLine : '',
        text,
      };
      if (Number.isInteger(oldLine)) oldLine += 1;
      if (Number.isInteger(newLine)) newLine += 1;
      return line;
    }
    return { type, oldNumber: '', newNumber: '', text };
  });
  return {
    additions,
    deletions,
    binary: false,
    lines: lines.slice(0, DIFF_RENDER_LINE_LIMIT),
    truncated: truncatedBySize || lines.length > DIFF_RENDER_LINE_LIMIT,
    totalLines: lines.length,
  };
}

function parsedDiffStats(parsed = {}) {
  if (parsed.binary || (!parsed.additions && !parsed.deletions)) return '';
  return `+${parsed.additions} −${parsed.deletions}`;
}

function diffStats(diff = '') {
  return parsedDiffStats(parseUnifiedDiff(diff));
}

function diffLineMarkup(line = {}) {
  return `<div class="codex-diff-line is-${escapeAttr(line.type || 'context')}">
    <span class="codex-diff-line-number" aria-hidden="true">${escapeHtml(String(line.oldNumber ?? ''))}</span>
    <span class="codex-diff-line-number" aria-hidden="true">${escapeHtml(String(line.newNumber ?? ''))}</span>
    <code>${escapeHtml(String(line.text ?? '')) || ' '}</code>
  </div>`;
}

function renderUnifiedDiff(diff = '', parsedDiff = null) {
  const parsed = parsedDiff || parseUnifiedDiff(diff);
  if (parsed.binary) return '<p class="codex-diff-notice is-binary">这是二进制文件变更，Janus 暂无可逐行显示的文本差异。</p>';
  if (!parsed.lines.length) return '<p class="codex-diff-notice">Janus 暂无可显示的差异内容。</p>';
  const initialLines = parsed.lines.slice(0, DIFF_INITIAL_LINE_LIMIT);
  const overflowLines = parsed.lines.slice(DIFF_INITIAL_LINE_LIMIT);
  return `<div class="codex-unified-diff" role="region" aria-label="文件差异">
    <div class="codex-diff-lines">${initialLines.map(diffLineMarkup).join('')}</div>
    ${overflowLines.length ? `<details class="codex-diff-overflow"><summary>继续显示其余 ${overflowLines.length} 行</summary><div class="codex-diff-lines">${overflowLines.map(diffLineMarkup).join('')}</div></details>` : ''}
    ${parsed.truncated ? `<p class="codex-diff-notice is-truncated">差异内容较大，仅显示前 ${parsed.lines.length} 行。</p>` : ''}
  </div>`;
}

function fileChangeCounts(changes = []) {
  const counts = new Map();
  changes.forEach((change) => {
    const label = fileChangeKind(change?.kind);
    counts.set(label, (counts.get(label) || 0) + 1);
  });
  return [...counts.entries()].map(([label, count]) => `${label} ${count} 个`).join('，');
}

function combinedDiffStats(changes = [], fallbackDiff = '') {
  const diffs = changes.map((change) => String(change?.diff || '')).filter(Boolean);
  const parsedDiffs = (diffs.length ? diffs : [fallbackDiff]).filter(Boolean).map(parseUnifiedDiff);
  const additions = parsedDiffs.reduce((sum, parsed) => sum + parsed.additions, 0);
  const deletions = parsedDiffs.reduce((sum, parsed) => sum + parsed.deletions, 0);
  if (!additions && !deletions) return '';
  return `+${additions} −${deletions}`;
}

function groupedFileActivity(items = []) {
  const first = items[0] || {};
  const changes = items.flatMap((item) => Array.isArray(item.changes) ? item.changes : []);
  const fallbackDiff = changes.length ? '' : items.map((item) => safeText(item.diff)).filter(Boolean).at(-1) || '';
  return {
    ...first,
    activityId: first.activityId || 'file-changes',
    status: items.some((item) => ['running', 'waiting'].includes(String(item.status || ''))) ? 'running' : first.status,
    title: '',
    changes,
    diff: fallbackDiff,
    diffSummary: combinedDiffStats(changes, fallbackDiff),
  };
}

function addDetail(sections, label, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value) && !value.length) return;
  if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return;
  sections.push(`<div><small>${escapeHtml(label)}</small><pre><code>${escapeHtml(prettyValue(value))}</code></pre></div>`);
}

function renderFileChanges(item = {}, options = {}) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (!changes.length && safeText(item.diff)) {
    const parsed = parseUnifiedDiff(item.diff);
    return `<div class="codex-file-change codex-turn-diff"><div class="codex-file-change-head"><strong>本轮差异</strong><span>${escapeHtml(parsedDiffStats(parsed))}</span></div>${renderUnifiedDiff(item.diff, parsed)}</div>`;
  }
  if (!changes.length) return '';
  return changes.map((change) => {
    const parsed = change?.diff ? parseUnifiedDiff(change.diff) : null;
    const stats = parsedDiffStats(parsed || {});
    const status = fileStatusLabel(change?.status || item.status);
    const semantic = fileSemanticDescription(change, change?.status || item.status, parsed || {});
    const workspaceRoot = safeText(change?.workspaceRoot) || safeText(item.workspaceRoot);
    const actionPayload = fileChangeKind(change?.kind) === '删除' || !fileChangeTargetPath(change) ? '' : fileActionPayload(change, workspaceRoot);
    const pathMarkup = actionPayload && options.enableFileActions !== false
      ? `<button class="codex-file-path-button" type="button" data-open-file="${actionPayload}" data-codex-file-action>${escapeHtml(fileChangeDisplayPath(change, workspaceRoot))}</button>`
      : `<code>${escapeHtml(fileChangeDisplayPath(change, workspaceRoot))}</code>`;
    return `<details class="codex-file-change">
      <summary><strong>${escapeHtml(fileChangeKind(change?.kind))}</strong>${pathMarkup}${stats ? `<span class="codex-file-change-stats">${escapeHtml(stats)}</span>` : ''}${status ? `<span class="codex-file-change-status is-${escapeAttr(String(change?.status || item.status))}">${escapeHtml(status)}</span>` : ''}</summary>
      ${(change?.movePath || change?.moveRelativePath) ? `<p>移动到 <code>${escapeHtml(fileChangeDisplayPath(change, workspaceRoot, { target: true }))}</code></p>` : ''}
      ${semantic ? `<div class="codex-file-semantic type-${escapeAttr(fileSemanticType(change)?.key || 'binary')}"><strong>${escapeHtml(semantic.label)}</strong><span>${escapeHtml(semantic.text)}</span></div>` : ''}
      ${renderStrictComparison(change, options)}
      ${change?.diff ? renderUnifiedDiff(change.diff, parsed) : '<p class="codex-diff-notice">Janus 暂无可显示的差异内容。</p>'}
      ${(safeText(item.nativeSource) || safeText(change?.comparison?.nativeChangeSource)) ? `<div class="codex-file-provenance">原生来源：${escapeHtml(safeText(item.nativeSource) || safeText(change.comparison.nativeChangeSource))}</div>` : ''}
      ${renderFileActions(change, { ...options, workspaceRoot })}
    </details>`;
  }).join('');
}

function warningSummary(item = {}) {
  if (typeof item.warning === 'string') return safeText(item.warning);
  if (item.warning && typeof item.warning === 'object') {
    return safeText(item.warning.summary) || safeText(item.warning.message) || safeText(item.warning.details);
  }
  return safeText(item.detail);
}

function renderOperationDetails(item = {}, options = {}) {
  const sections = [];
  if (item.activityType === 'file') return renderFileChanges(item, options);
  if (item.activityType === 'tool') {
    addDetail(sections, '工具', [item.toolServer, item.toolName].filter(Boolean).join(' / '));
    addDetail(sections, '参数', item.arguments);
    addDetail(sections, '结果', item.result);
    addDetail(sections, '错误', item.error);
  } else if (item.activityType === 'search') {
    addDetail(sections, '检索词', item.query || item.detail);
    addDetail(sections, '检索结果', item.searchResults);
  } else if (item.activityType === 'agent') {
    addDetail(sections, 'Agent 操作', item.agentTool);
    addDetail(sections, '任务', item.prompt);
    addDetail(sections, '状态', item.agentsStates);
  } else if (item.activityType === 'approval') {
    addDetail(sections, '请求类型', item.approvalType === 'file' ? '文件修改' : item.approvalType === 'command' ? '命令执行' : '操作权限');
    addDetail(sections, '原因', item.detail);
    addDetail(sections, '命令', item.command);
    addDetail(sections, '位置', item.cwd);
    addDetail(sections, '决定', item.decision);
    if (Array.isArray(item.changes) && item.changes.length) sections.push(renderFileChanges({ ...item, status: item.status || 'waiting' }, options));
  } else if (item.activityType === 'warning') {
    addDetail(sections, '提示', warningSummary(item));
    if (item.warning?.details && safeText(item.warning.details) !== warningSummary(item)) addDetail(sections, '补充说明', item.warning.details);
  } else {
    addDetail(sections, '详情', item.detail);
    addDetail(sections, '结果', item.result || item.error || item.warning);
  }
  return sections.join('');
}

function operationLabel(item = {}) {
  if (item.activityType === 'file') return fileOperationLabel(item);
  if (item.activityType === 'approval') {
    if (item.status === 'cancelled') return '操作未获批准';
    if (item.status === 'completed' || item.status === 'running') return '操作已确认';
    return '需要确认一项操作';
  }
  const labels = {
    file: '文件修改', tool: '工具调用', search: '资料检索', agent: 'Agent 协作', image: '图像处理',
    warning: '提示', error: '执行错误', review: '代码审查', context: '上下文处理', plan: '执行计划',
    model: '模型状态', sandbox: '运行环境', wait: '等待', approval: '需要确认',
  };
  return safeText(item.title) || labels[item.activityType] || '执行记录';
}

function operationSummary(item = {}) {
  if (item.activityType === 'file' && Array.isArray(item.changes) && item.changes.length) {
    const stats = safeText(item.diffSummary) || combinedDiffStats(item.changes, item.diff);
    const strictCount = item.changes.filter((change) => change?.comparison?.strict === true).length;
    const incompleteCount = item.changes.filter((change) => change?.comparison && change.comparison.status !== 'complete').length;
    const comparison = strictCount ? `严格对照 ${strictCount}` : incompleteCount ? `对照待完善 ${incompleteCount}` : '';
    if (item.changes.length === 1) return [fileChangeDisplayPath(item.changes[0], item.workspaceRoot), stats, comparison].filter(Boolean).join(' · ');
    return [fileChangeCounts(item.changes), stats, comparison].filter(Boolean).join(' · ');
  }
  if (item.activityType === 'file' && safeText(item.diff)) return ['本轮统一差异', safeText(item.diffSummary) || diffStats(item.diff)].filter(Boolean).join(' · ');
  if (item.activityType === 'approval' && Array.isArray(item.changes) && item.changes.length) {
    const paths = item.changes.map((change) => fileChangeDisplayPath(change, item.workspaceRoot)).filter(Boolean);
    return paths.length <= 2 ? paths.join('、') : `${paths.slice(0, 2).join('、')} 等 ${paths.length} 个文件`;
  }
  if (item.activityType === 'warning') return warningSummary(item);
  return safeText(item.detail);
}

function renderOperation(item = {}, { messageId = '', actorLabelForEvent = null } = {}) {
  const options = { messageId, actorLabelForEvent, enableFileActions: !String(messageId || '').startsWith('task-') };
  const details = renderOperationDetails(item, options);
  const summary = operationSummary(item);
  const toggleId = `${messageId}::${item.activityId}`;
  const waitingForModel = item.activityType === 'model' && String(item.activityId || '').startsWith('model-first-response-waiting-');
  return `<details class="codex-operation-item type-${escapeAttr(item.activityType)} is-${escapeAttr(item.status)}${waitingForModel ? ' is-model-waiting' : ''}" data-codex-operation-toggle="${escapeAttr(toggleId)}"${waitingForModel ? ' data-model-waiting' : ''}${item.expanded === true ? ' open' : ''}>
    <summary><strong>${escapeHtml(operationLabel(item))}</strong>${summary ? `<span>${escapeHtml(clipInline(summary, 160))}</span>` : ''}${actorMarkup(item, actorLabelForEvent)}</summary>
    <div>${details || '<p>暂无额外详情。</p>'}</div>
  </details>`;
}

function renderSystemStatus(item = {}, actorLabelForEvent = null) {
  return `<div class="codex-system-status is-${escapeAttr(item.status)}">
    <strong>${escapeHtml(item.title || '系统状态')}</strong>
    ${item.detail ? `<span>${escapeHtml(item.detail)}</span>` : ''}
    ${actorMarkup(item, actorLabelForEvent)}
  </div>`;
}

function technicalActivityLabel(item = {}) {
  if (isGenericProtocolStatus(item)) return '线程与轮次状态';
  return ({ protocol: '协议事件', usage: 'Token 使用量', answer: '最终回答事件', progress: '进度同步', heartbeat: '心跳', routing: '路由状态' })[item.activityType]
    || safeText(item.title) || '技术事件';
}

function technicalMetadata(item = {}) {
  const metadata = { ...item };
  delete metadata.protocolEvents;
  delete metadata.payload;
  delete metadata.reasoningText;
  delete metadata.workspaceRoot;
  if (metadata.cwd) metadata.cwd = humanPath(metadata.cwd);
  if (Array.isArray(metadata.changes)) {
    metadata.changes = metadata.changes.map((change) => {
      const comparison = change?.comparison && typeof change.comparison === 'object'
        ? {
            ...change.comparison,
            before: change.comparison.before ? {
              ...change.comparison.before,
              snapshot: change.comparison.before.snapshot ? { ...change.comparison.before.snapshot, path: undefined } : undefined,
            } : undefined,
            after: change.comparison.after ? {
              ...change.comparison.after,
              snapshot: change.comparison.after.snapshot ? { ...change.comparison.after.snapshot, path: undefined } : undefined,
            } : undefined,
          }
        : change?.comparison;
      return {
        ...change,
        path: change?.relativePath || humanPath(change?.path),
        movePath: change?.moveRelativePath || humanPath(change?.movePath),
        comparison,
      };
    });
  }
  return metadata;
}

function renderProtocolEvents(events = []) {
  if (!Array.isArray(events) || !events.length) return '';
  return `<details class="codex-raw-protocol"><summary>上游原始协议 · ${events.length} 个事件</summary><div>${events.map((event) => `<details>
    <summary><code>${escapeHtml(String(event?.method || 'event'))}</code></summary>
    <pre><code>${escapeHtml(prettyValue(event))}</code></pre>
  </details>`).join('')}</div></details>`;
}

function renderTechnicalActivity(item = {}) {
  const eventCount = Array.isArray(item.protocolEvents) ? item.protocolEvents.length : 0;
  return `<details class="codex-technical-activity">
    <summary><strong>${escapeHtml(technicalActivityLabel(item))}</strong>${eventCount ? `<small>${eventCount} 个原始事件</small>` : ''}</summary>
    <div><div><small>完整活动数据</small><pre><code>${escapeHtml(prettyValue(technicalMetadata(item)))}</code></pre></div>${renderProtocolEvents(item.protocolEvents)}</div>
  </details>`;
}

function renderTechnicalStream(events = []) {
  const technical = events.filter((item) => isTechnicalActivity(item));
  const metadataBearing = events.filter((item) => !isTechnicalActivity(item) && visibleEvent(item));
  const activities = [...technical, ...metadataBearing];
  if (!activities.length) return '';
  const rawCount = activities.reduce((sum, item) => sum + (Array.isArray(item.protocolEvents) ? item.protocolEvents.length : 0), 0);
  return `<details class="codex-technical-stream">
    <summary>技术事件 · ${activities.length} 项${rawCount ? ` · ${rawCount} 个原始事件` : ''}</summary>
    <div>${activities.map(renderTechnicalActivity).join('')}</div>
  </details>`;
}

function transcriptDuration(startedAt = 0, durationMs = 0) {
  const elapsedMs = Number(durationMs || 0) > 0
    ? Number(durationMs)
    : Number(startedAt || 0) > 0 ? Math.max(0, Date.now() - Number(startedAt)) : 0;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderLiveStatus(startedAt = 0, durationMs = 0) {
  const duration = transcriptDuration(startedAt, durationMs);
  return `<div class="codex-live-status" data-process-started-at="${Number(startedAt || 0)}" data-process-duration-ms="${Number(durationMs || 0)}"><span>处理中</span><small data-process-duration>${escapeHtml(duration)}</small></div>`;
}

function renderTranscriptBlock(block = {}, options = {}) {
  if (block.type === 'commands') return renderCommandGroup(block.items, options);
  if (block.type === 'tools') return renderToolGroup(block.items, options);
  if (block.type === 'files') return renderOperation(groupedFileActivity(block.items), options);
  const item = block.item;
  if (!item) return '';
  if (item.eventOrigin === 'janus' || eventOrigin(item) === 'janus') return renderSystemStatus(item, options.actorLabelForEvent);
  if (item.activityType === 'reasoning' || item.activityType === 'commentary') return renderNarrative(item, options.actorLabelForEvent, { active: Boolean(options.streaming && options.isLatestBlock) });
  return renderOperation(item, options);
}

function batchOperationCount(blocks = []) {
  return blocks.reduce((count, block) => count + (Array.isArray(block.items) ? block.items.length : 1), 0);
}

function batchHasActiveOperation(blocks = []) {
  return blocks.some((block) => {
    const items = Array.isArray(block.items) ? block.items : block.item ? [block.item] : [];
    return items.some((item) => ['running', 'waiting'].includes(String(item?.status || '')));
  });
}

function renderReasoningBatch(block = {}, options = {}) {
  const narrative = renderNarrative(block.narrative, options.actorLabelForEvent, { active: Boolean(options.streaming && options.isLatestBlock) });
  if (!block.blocks?.length) return narrative;
  const count = batchOperationCount(block.blocks);
  const active = batchHasActiveOperation(block.blocks);
  return `<div class="codex-reasoning-batch">${narrative}<details class="codex-reasoning-actions"${active ? ' open' : ''}>
    <summary><span>${active ? '正在执行' : '已执行'} ${count} 项操作</span></summary>
    <div>${block.blocks.map((child) => renderTranscriptBlock(child, options)).join('')}</div>
  </details></div>`;
}

export function renderCodexTranscript(events = [], {
  messageId = '', streaming = false, actorLabelForEvent = null, startedAt = 0, durationMs = 0,
  includeTechnicalDetails = false,
} = {}) {
  const items = (Array.isArray(events) ? events : []).map(normalizedEvent);
  const blocks = transcriptBlocks(items);
  // A run can initially contain only technical or Janus status events. Keep the
  // live container visible so later reasoning, actions, and answer tokens can
  // be reconciled into the conversation before the run settles.
  if (!blocks.length && !streaming) return '';
  const technical = includeTechnicalDetails ? renderTechnicalStream(items) : '';
  const renderOptions = { messageId, actorLabelForEvent, streaming };
  return `<section class="codex-transcript${streaming ? ' is-streaming' : ''}" aria-label="Janus 处理过程">
    ${streaming ? renderLiveStatus(startedAt, durationMs) : ''}
    ${blocks.map((block, index) => {
      const blockOptions = { ...renderOptions, isLatestBlock: index === blocks.length - 1 };
      return block.type === 'batch'
        ? renderReasoningBatch(block, blockOptions)
        : renderTranscriptBlock(block, { ...blockOptions, direct: true });
    }).join('')}
    ${technical}
  </section>`;
}
