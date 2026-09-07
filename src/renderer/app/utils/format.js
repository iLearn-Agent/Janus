import { iconSvg } from '../ui/icons.js';
import katex from '../../../../node_modules/katex/dist/katex.mjs';
import { PASSWORD_REQUIREMENTS_MESSAGE } from '../../../shared/passwordPolicy.js';

export function formatText(text) {
  return renderMarkdown(text);
}

export function janusBrandText(value = '') {
  return String(value ?? '')
    .replace(/(?:oplith|janus)_follower/gi, 'Janus Follower')
    .replace(/\bOplith\b/gi, 'Janus')
    .replaceAll('Codex App Server', 'Janus runtime')
    .replaceAll('Codex app-server', 'Janus runtime')
    .replaceAll('Codex CLI', 'Janus runtime')
    .replaceAll('Codex Doctor', 'Janus diagnostics')
    .replace(/\bCodex(?=[A-Z][A-Za-z]*\b)/g, 'Janus')
    .replace(/\bCodex\b/g, 'Janus');
}

export function userVisibleErrorMessage(error, fallback = '操作失败，请重试。') {
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
  const structured = error?.body?.error?.message
    || error?.body?.message
    || (typeof error?.body?.error === 'string' ? error.body.error : '');
  let message = String(structured || error?.message || error || '').trim();
  const replacements = [
    [/Error invoking remote method '[^']+':\s*/gi, ''],
    [/\b(?:NetworkRequestError|FetchError|AxiosError):\s*/gi, ''],
    [/\b(?:Janus communication|Cloud)\s+(?:GET|POST|PUT|PATCH|DELETE)\s+\S+\s+failed\s*\(\d+\):\s*/gi, ''],
    [/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/\S+|\/\S+)\s+failed\s*\(\d+\):\s*/gi, ''],
    [/\bRequest failed\s*\(\d+\):\s*/gi, ''],
    [/(^|[：:]\s*)Error:\s*/gi, '$1'],
  ];
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [pattern, replacement] of replacements) message = message.replace(pattern, replacement);
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (['session_expired', 'access_token_expired', 'refresh_token_expired'].includes(code)) return '登录状态已失效，请重新登录。';
  if (code === 'cloud_auth_required') return '请先登录并绑定云端账号，再修改员工启用状态。';
  if (code === 'invalid_email') return '邮箱格式不正确，请检查后重试。';
  if (code === 'email_not_found') return '该邮箱尚未注册。';
  if (code === 'email_already_registered') return '该邮箱已被注册，请直接登录或使用其他邮箱。';
  if (code === 'email_address_unreachable') return '该邮箱不存在或无法接收邮件，请检查邮箱地址后重试。';
  if (code === 'email_delivery_failed') return '验证码邮件发送失败，请稍后重试；如果持续失败，请确认邮箱能够正常收件。';
  if (code === 'email_code_required') return '请输入邮箱验证码。';
  if (code === 'email_code_expired') return '邮箱验证码已过期，请重新获取。';
  if (code === 'email_code_invalid') return '邮箱验证码不正确。';
  if (code === 'invalid_password') return message || PASSWORD_REQUIREMENTS_MESSAGE;
  if (code === 'device_approval_pending') return '当前设备正在等待另一台已授权设备批准。';
  if (code === 'device_not_approved') return '当前设备尚未获得云端同步授权，请重新登录或稍后重试。';
  if (['device_grant_invalid', 'device_grant_expired', 'device_grant_revoked'].includes(code)) return '设备授权已失效，正在等待重新授权。';
  if (code === 'cloud_sync_contract_unsupported') return '云端服务版本较旧，暂不支持当前同步协议。';
  if (code === 'sync_client_contract_required') return '当前云端已启用数据库安全协商，请升级 Janus 后再同步。';
  if (code === 'sync_client_incompatible') return '当前 Janus 的本地数据库结构与云端同步契约不兼容；同步已暂停，数据不会被写入，请先升级软件。';
  if (code === 'evolution_account_paused') return '账户自进化已暂停；恢复后才能采用新的 Skill 或加入 Canary。';
  if (code === 'market_skill_conflict') return '当前有效市场 Skill 已发生变化，请刷新后重新选择。';
  if (code === 'chat_context_state_conflict' || /Chat context state changed on another device/i.test(message)) {
    return '上下文状态刚刚发生了变化，请重试。';
  }
  if (code === 'chat_context_scope_changed') return '压缩期间当前 Memory 或 Context Space 已切换，请在新上下文中重试。';
  if (code === 'agent_not_recruitable') return '该 Agent 当前不在云端可招募目录中，请刷新人才市场。';
  if (code === 'agent_skill_install_required') return '请先在本机安装该 Agent 所需的 Skill，安装完成后再招募。';
  if (code === 'employee_quota_exceeded') return '可招募员工数量已达到上限。';
  if (code === 'employee_command_pending') return '该员工的启用状态正在同步，请稍候；无需重复操作。';
  if (code === 'employee_state_conflict') return '员工状态已在其他设备发生变化，请刷新后重试。';
  if (/^(?:unauthorized|unauthenticated)$/i.test(message)) return '云端拒绝了当前请求；这不一定表示登录过期，请检查云端服务版本或授权状态。';
  return janusBrandText(message || fallback);
}

export function stripAttachmentResourceBlock(content = '') {
  return String(content || '').split(/\n\n附加资源:\n\n/)[0];
}

// Keep image-source detection in the shared renderer formatting utilities so
// every message surface uses the same safe predicate.  A malformed attachment
// must fall back to its placeholder instead of aborting the whole conversation
// render with a ReferenceError.
export function isImageSource(value = '') {
  const source = String(value || '').trim();
  if (!source) return false;
  return source.startsWith('data:image/')
    || source.startsWith('blob:')
    || source.startsWith('file:')
    || /^https?:\/\//i.test(source)
    || source.startsWith('/')
    || source.startsWith('./')
    || source.startsWith('../');
}

export function stripHiddenMarkdownBlocks(content = '') {
  return String(content || '').replace(
    /```(?:janus-deck-spec|janus-slide-plan)\b[^\n]*\n[\s\S]*?(?:```|$)/gi,
    '',
  ).replace(/\n{3,}/g, '\n\n').trim();
}

export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const parts = [];
  const paragraph = [];
  let index = 0;
  let nextOrderedListStart = null;

  const flushParagraph = () => {
    const content = paragraph.splice(0).map((line) => line.trimEnd()).filter(Boolean);
    if (!content.length) return;
    parts.push(`<p>${content.map(renderInlineMarkdown).join('<br />')}</p>`);
    nextOrderedListStart = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```(\S*)?/);
    if (fenceMatch) {
      flushParagraph();
      const language = fenceMatch[1] || '';
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nextOrderedListStart = null;
      if (['janus-deck-spec', 'janus-slide-plan'].includes(language.toLowerCase())) continue;
      const languageLabel = codeLanguageLabel(language);
      parts.push(`<div class="message-code-shell"><div class="message-code-head"><span class="message-code-language" data-code-language data-no-localize>${escapeHtml(languageLabel)}</span><button class="message-code-copy" type="button" data-copy-code-block data-localize-ui title="复制代码" aria-label="复制代码"><span class="message-code-copy-icon" aria-hidden="true">${iconSvg('copy')}</span><span data-code-copy-label>复制</span></button></div><pre class="message-code-block"><code${language ? ` data-language="${escapeAttr(language)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre></div>`);
      continue;
    }

    const mathBlock = consumeMarkdownMathBlock(lines, index);
    if (mathBlock) {
      flushParagraph();
      parts.push(renderMathExpression(mathBlock.expression, { displayMode: true }));
      index = mathBlock.nextIndex;
      nextOrderedListStart = null;
      continue;
    }

    if (isMarkdownTableLine(line)) {
      const tableLines = [];
      while (index < lines.length && isMarkdownTableLine(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      if (tableLines.length >= 2) {
        flushParagraph();
        parts.push(renderMarkdownTable(tableLines));
        nextOrderedListStart = null;
        continue;
      }
      paragraph.push(line);
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length + 2;
      parts.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      nextOrderedListStart = null;
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      parts.push(`<blockquote>${quoteLines.map(renderInlineMarkdown).join('<br />')}</blockquote>`);
      nextOrderedListStart = null;
      continue;
    }

    const listMatch = trimmed.match(/^((?:[-*+])|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      const ordered = /^\d/.test(listMatch[1]);
      const items = [];
      const explicitStart = ordered ? Math.max(1, Number.parseInt(listMatch[1], 10) || 1) : 1;
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^((?:[-*+])|\d+[.)])\s+(.+)$/);
        if (!itemMatch || (/^\d/.test(itemMatch[1]) !== ordered)) break;
        items.push(`<li>${renderInlineMarkdown(itemMatch[2])}</li>`);
        index += 1;
      }
      if (ordered) {
        const start = nextOrderedListStart !== null && explicitStart === 1 ? nextOrderedListStart : explicitStart;
        parts.push(`<ol${start === 1 ? '' : ` start="${start}"`}>${items.join('')}</ol>`);
        nextOrderedListStart = start + items.length;
      } else {
        parts.push(`<ul>${items.join('')}</ul>`);
      }
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return `<div class="message-markdown">${parts.join('')}</div>`;
}

function codeLanguageLabel(value = '') {
  const language = String(value || '').trim().toLowerCase();
  if (!language) return 'TEXT';
  return ({
    js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
    ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
    py: 'Python', python: 'Python',
    sh: 'Shell', shell: 'Shell', bash: 'Bash', zsh: 'Zsh', powershell: 'PowerShell', ps1: 'PowerShell',
    json: 'JSON', jsonc: 'JSONC', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
    sql: 'SQL', yaml: 'YAML', yml: 'YAML', xml: 'XML', markdown: 'Markdown', md: 'Markdown',
    java: 'Java', kotlin: 'Kotlin', swift: 'Swift', go: 'Go', rust: 'Rust', c: 'C', cpp: 'C++', csharp: 'C#', cs: 'C#',
  })[language] || language.toUpperCase();
}

export function isMarkdownTableLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return false;
  const cells = splitMarkdownTableRow(trimmed);
  return cells.length >= 2 && cells.some((cell) => cell.trim());
}

export function splitMarkdownTableRow(line) {
  let text = String(line || '').trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  const cells = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (char === '|' && !escaped) {
      cells.push(current.trim().replace(/\\\|/g, '|'));
      current = '';
      continue;
    }
    if (char === '\\' && !escaped) {
      escaped = true;
      current += char;
      continue;
    }
    escaped = false;
    current += char;
  }
  cells.push(current.trim().replace(/\\\|/g, '|'));
  return cells;
}

export function isMarkdownTableSeparator(cells = []) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function renderMarkdownTable(tableLines) {
  const rows = tableLines.map(splitMarkdownTableRow);
  const hasSeparator = rows.length > 1 && isMarkdownTableSeparator(rows[1]);
  const likelyHeader = hasSeparator || isLikelyMarkdownTableHeader(rows[0]);
  const header = likelyHeader ? rows[0] : [];
  const bodyRows = rows.slice(hasSeparator ? 2 : likelyHeader ? 1 : 0);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const renderCell = (cell, tag) => `<${tag}>${renderInlineMarkdown(cell)}</${tag}>`;
  const columnLabels = normalizeTableRow(header, columnCount);
  const renderBodyCell = (cell, columnIndex) => `<td data-column-label="${escapeAttr(columnLabels[columnIndex] || `第 ${columnIndex + 1} 列`)}"><span class="message-table-cell-content">${renderInlineMarkdown(cell)}</span></td>`;
  return `
    <div class="message-table-scroll" role="region" aria-label="Markdown table">
      <table class="message-markdown-table" data-column-count="${columnCount}">
        <colgroup>${Array.from({ length: columnCount }, () => '<col />').join('')}</colgroup>
        ${header.length ? `<thead><tr>${normalizeTableRow(header, columnCount).map((cell) => renderCell(cell, 'th')).join('')}</tr></thead>` : ''}
        <tbody>
          ${bodyRows.map((row) => `<tr>${normalizeTableRow(row, columnCount).map(renderBodyCell).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

export function normalizeTableRow(row, columnCount) {
  const result = row.slice(0, columnCount);
  while (result.length < columnCount) result.push('');
  return result;
}

export function isLikelyMarkdownTableHeader(row = []) {
  const headerText = row.join(' ').toLowerCase();
  return /\b(layout_id|title|message|visual|speaker|time|proof_object|page|slide)\b/.test(headerText)
    || /标题|正文|内容|视觉|讲稿|时间|页面|页码/.test(headerText);
}

export function renderInlineMarkdown(value) {
  const tokens = [];
  let source = String(value ?? '').replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@JANUS_CODE_${tokens.length}@@`;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });
  source = source.replace(/\\\((.+?)\\\)/g, (_, expression) => inlineMathToken(tokens, expression));
  source = source.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix, expression) => `${prefix}${inlineMathToken(tokens, expression)}`);
  source = replaceInlineMarkdownLinks(source, (match, label, target) => {
    const cleanTarget = normalizeLocalMarkdownFileTarget(target);
    const token = `@@JANUS_CODE_${tokens.length}@@`;
    if (/^https?:\/\/[^\s]+$/i.test(cleanTarget)) {
      tokens.push(`<a href="${escapeAttr(cleanTarget)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
      return token;
    }
    if (!isLocalMarkdownFileTarget(cleanTarget)) return match;
    tokens.push(`<button type="button" class="message-local-file-link" data-preview-local-file="${escapeAttr(cleanTarget)}">${escapeHtml(label)}</button>`);
    return token;
  });
  let html = escapeHtml(source);
  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>');
  tokens.forEach((tokenHtml, tokenIndex) => {
    html = html.replace(`@@JANUS_CODE_${tokenIndex}@@`, tokenHtml);
  });
  return html;
}

function replaceInlineMarkdownLinks(source = '', replacer) {
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const labelStart = source.indexOf('[', cursor);
    if (labelStart < 0) return output + source.slice(cursor);
    const labelEnd = source.indexOf('](', labelStart + 1);
    if (labelEnd < 0) return output + source.slice(cursor);
    let depth = 1;
    let targetEnd = labelEnd + 2;
    for (; targetEnd < source.length; targetEnd += 1) {
      const character = source[targetEnd];
      if (character === '\\') {
        targetEnd += 1;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')' && --depth === 0) break;
    }
    if (depth !== 0) return output + source.slice(cursor);
    const match = source.slice(labelStart, targetEnd + 1);
    const label = source.slice(labelStart + 1, labelEnd);
    const target = source.slice(labelEnd + 2, targetEnd);
    output += source.slice(cursor, labelStart) + replacer(match, label, target);
    cursor = targetEnd + 1;
  }
  return output;
}

export function consumeMarkdownMathBlock(lines = [], index = 0) {
  const first = String(lines[index] || '').trim();
  const delimiter = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : '';
  if (!delimiter) return null;
  const closing = delimiter === '$$' ? '$$' : '\\]';
  const initial = first.slice(delimiter.length);
  if (initial.endsWith(closing)) {
    return { expression: initial.slice(0, -closing.length).trim(), nextIndex: index + 1 };
  }
  const expressionLines = initial ? [initial] : [];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = String(lines[cursor] || '');
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(closing)) {
      expressionLines.push(trimmed.slice(0, -closing.length));
      return { expression: expressionLines.join('\n').trim(), nextIndex: cursor + 1 };
    }
    expressionLines.push(line);
    cursor += 1;
  }
  return null;
}

export function renderMathExpression(expression = '', { displayMode = false } = {}) {
  const source = String(expression || '').trim();
  if (!source) return '';
  const markup = katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    strict: false,
    trust: false,
    output: 'htmlAndMathml',
  });
  const tag = displayMode ? 'div' : 'span';
  const className = displayMode ? 'message-math-block' : 'message-math-inline';
  return `<${tag} class="${className}" role="math" aria-label="${escapeAttr(source)}">${markup}</${tag}>`;
}

function inlineMathToken(tokens, expression) {
  const token = `@@JANUS_CODE_${tokens.length}@@`;
  tokens.push(renderMathExpression(expression));
  return token;
}

export function isLocalMarkdownFileTarget(value = '') {
  const target = normalizeLocalMarkdownFileTarget(value);
  if (!target || target.startsWith('#')) return false;
  if (/^file:\/\/\//i.test(target) || /^[a-z]:[\\/]/i.test(target)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return true;
}

export function normalizeLocalMarkdownFileTarget(value = '') {
  let target = String(value || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  const titled = target.match(/^(.*?)\s+["'][^"']*["']$/);
  if (titled) target = titled[1];
  return target.replace(/^['"]|['"]$/g, '').trim();
}

export function renderStatusBadge(value) {
  const label = statusLabel(value);
  return `<span class="status-badge ${statusClass(value)}">${escapeHtml(label)}</span>`;
}

export function statusClass(value) {
  const slug = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
  return `status-${slug}`;
}

export function statusLabel(value) {
  const text = String(value || 'unknown');
  const labels = {
    active: 'active',
    applied: 'applied',
    archived: 'archived',
    blocked: 'blocked',
    calibrated: 'calibrated',
    candidate: 'candidate',
    assessment_pending: '准入考核',
    completed: 'completed',
    failed: 'failed',
    full: 'full',
    idle: 'idle',
    insufficient_data: 'insufficient',
    partial: 'partial',
    passed: 'passed',
    proposed: 'proposed',
    promote_candidate: 'promote',
    reject: 'reject',
    reject_candidate: 'reject',
    rejected: 'rejected',
    running: 'running',
    skipped: 'skipped',
    unknown: 'unknown',
  };
  return labels[text] || text;
}

export function releaseLabel(release) {
  if (!release) return '-';
  if (release.status === 'ok') {
    const manifest = release.manifest || {};
    const version = release.version || manifest.version || 'unknown';
    const id = manifest.id ? ` (${manifest.id})` : '';
    return `${version}${id}`;
  }
  if (release.status === 'empty') return 'No release';
  if (release.status === 'skipped') return 'Cloud URL not configured';
  if (release.status === 'failed') return release.error || 'Failed';
  return release.status || '-';
}

export function agentBundleStatus(...releases) {
  for (const release of releases) {
    const artifacts = release?.manifest?.artifacts || [];
    const bundle = artifacts.find((item) => item.kind === 'agent_bundle' || String(item.name || '').includes('agents'));
    if (bundle) return `${bundle.name || 'agent bundle'} / ${shortHash(bundle.sha256)}`;
  }
  return 'Not discovered';
}

export function formatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('en-US');
}

export function formatBytes(value) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function statusLabelForAttachment(item) {
  if (item.status === 'uploading') return '上传中';
  if (item.status === 'done') return '已就绪';
  if (item.status === 'error') return item.error || '上传失败';
  return '等待上传';
}

export function formatScore(value, digits = 3) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return (0).toFixed(digits);
  return number.toFixed(digits);
}

export function formatPercent(numerator, denominator) {
  const top = Number(numerator || 0);
  const bottom = Number(denominator || 0);
  if (!bottom) return '0%';
  return `${Math.round((top / bottom) * 100)}%`;
}

export function ratioPercent(numerator, denominator) {
  const top = Number(numerator || 0);
  const bottom = Number(denominator || 0);
  if (!bottom) return 0;
  return clampNumber((top / bottom) * 100, 0, 100);
}

export function clampNumber(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMessageTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return date.toLocaleString('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatChatCardMessageTime(value, { now = new Date(), languageMode = 'zh-CN' } = {}) {
  if (!value) return '';
  const date = new Date(value);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const calendarDay = (item) => Date.UTC(item.getFullYear(), item.getMonth(), item.getDate()) / 86_400_000;
  const daysAgo = calendarDay(current) - calendarDay(date);
  const english = languageMode === 'en';
  if (daysAgo === 0) return time;
  if (daysAgo === 1) return `${english ? 'Yesterday' : '昨天'} ${time}`;
  if (daysAgo > 1 && daysAgo < 7) {
    const weekday = english
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]
      : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
    return `${weekday} ${time}`;
  }
  const dateLabel = english
    ? `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
    : `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`;
  return `${dateLabel} ${time}`;
}

export function clipInline(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}\u2026` : text;
}

export function quotaUsagePercent(used, limit) {
  const safeUsed = Math.max(0, Number(used) || 0);
  const safeLimit = Math.max(1, Number(limit) || 1);
  return Number(Math.min(100, (safeUsed / safeLimit) * 100).toFixed(2));
}

export function formatQuotaPercent(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return percent.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: percent > 0 && percent < 1 ? 2 : 1 });
}

export function isInternalTaskRecord(task = {}) {
  const source = String(task?.metadata?.source || '').trim();
  return Boolean(task?.metadata?.internalTest) || [
    'real_blocking_communication_test',
    'codex_remote_real_api_test',
    'real_agent_collaboration_smoke_test',
  ].includes(source);
}

export function displayNodeTitle(node = {}, fallback = '\u4efb\u52a1\u8282\u70b9') {
  const title = String(node?.title || '').trim();
  if (!title || looksLikeQuestionMarkMojibake(title)) return fallback;
  const labels = {
    'paper or written report workstream': '\u8bba\u6587/\u62a5\u544a\u64b0\u5199',
    'ppt/storytelling workstream': 'PPT \u53d9\u4e8b\u8bbe\u8ba1',
    'cross-department synthesis': '\u8de8\u90e8\u95e8\u7efc\u5408',
    'cross-department evidence and context scan': '\u8de8\u90e8\u95e8\u8bc1\u636e\u4e0e\u80cc\u666f\u8c03\u7814',
    'method and evaluation design': '\u65b9\u6cd5\u4e0e\u8bc4\u4f30\u8bbe\u8ba1',
    'project or proposal workstream': '\u9879\u76ee/\u7533\u62a5\u5de5\u4f5c',
    'exact structured blocking communication request': '\u963b\u585e\u901a\u4fe1\u8bf7\u6c42',
  };
  return labels[title.toLowerCase()] || title;
}

export function displayTaskTitle(task = {}, fallback = '\u534f\u4f5c\u4efb\u52a1') {
  const metadata = task?.metadata || {};
  const sourceTitle = String(metadata.sourceTitle || '').trim();
  if (sourceTitle) return `\u534f\u4f5c\uff1a${sourceTitle}`;

  const title = String(task?.title || '').trim();
  if (!title) return fallback;
  if (title.startsWith('\u8bf7\u628a\u4e0b\u9762\u8fd9\u6bb5\u65e7\u5bf9\u8bdd\u4f5c\u4e3a\u4e00\u4e2a\u591a\u90e8\u95e8')) return '\u65e7\u5bf9\u8bdd\u534f\u4f5c\u4efb\u52a1';

  if (looksLikeQuestionMarkMojibake(title)) {
    const source = String(metadata.source || '').trim();
    const labels = {
      real_blocking_communication_test: '\u963b\u585e\u901a\u4fe1\u6d4b\u8bd5',
      codex_remote_real_api_test: 'OpenAI \u771f\u5b9e Agent \u901a\u4fe1\u6d4b\u8bd5',
      real_agent_collaboration_smoke_test: '\u771f\u5b9e Agent \u534f\u4f5c\u6d4b\u8bd5',
    };
    return labels[source] || fallback;
  }

  return title;
}

function looksLikeQuestionMarkMojibake(value) {
  const text = String(value || '');
  const questionMarkRuns = text.match(/\?{2,}/g) || [];
  const questionMarkCount = questionMarkRuns.reduce((sum, run) => sum + run.length, 0);
  return questionMarkCount >= 3 && !/[\u4e00-\u9fff]/.test(text);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

export function shortHash(value) {
  return String(value || '').slice(0, 10);
}
