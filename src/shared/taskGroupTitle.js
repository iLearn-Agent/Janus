const AUTO_TITLE_MODE = 'auto';
const MANUAL_TITLE_MODE = 'manual';

export function taskGroupParticipantLabel(user = {}) {
  return String(user.displayName || user.display_name || user.username || user.email || user.id || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}

export function summarizeTaskGroupObjective(value = '', maxLength = 22) {
  let summary = String(value || '')
    .replace(/@[\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  summary = summary
    .replace(/^(?:请帮我|请先|麻烦|帮我|需要|希望|请)(?:你|大家|团队|协助)?[，,:：\s]*/u, '')
    .replace(/^由.{1,40}?(?:协作|共同|一起)(?=(?:完成|撰写|编写|制作|整理|研究|分析|实现|开发))/u, '')
    .replace(/[（(][A-Za-z][A-Za-z\s_-]{2,40}[）)]/gu, '')
    .replace(/^(?:共同|协作|一起)[，,:：\s]*/u, '')
    .replace(/[。；;，,：:\s]+$/u, '')
    .trim();
  if (!summary) summary = '协作任务';
  const limit = Math.max(8, Number(maxLength || 22));
  return summary.length > limit ? `${summary.slice(0, limit - 1).trim()}…` : summary;
}

export function formatTaskGroupParticipants(participants = []) {
  const labels = [];
  const seen = new Set();
  for (const item of Array.isArray(participants) ? participants : []) {
    const label = typeof item === 'string' ? String(item).trim().slice(0, 12) : taskGroupParticipantLabel(item);
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  if (labels.length > 3) return `${labels.slice(0, 2).join('、')}等${labels.length}人`;
  return labels.join('、');
}

export function buildTaskGroupTitle({ objective = '', participants = [] } = {}) {
  const summary = summarizeTaskGroupObjective(objective);
  const memberText = formatTaskGroupParticipants(participants);
  return `${summary}${memberText ? ` · ${memberText}` : ''}`.slice(0, 80);
}

export function automaticTaskGroupTitleMetadata(objective = '') {
  return { mode: AUTO_TITLE_MODE, summary: summarizeTaskGroupObjective(objective) };
}

export function manualTaskGroupTitleMetadata(metadata = {}) {
  const current = metadata?.taskGroupTitle && typeof metadata.taskGroupTitle === 'object'
    ? metadata.taskGroupTitle
    : {};
  return { ...metadata, taskGroupTitle: { ...current, mode: MANUAL_TITLE_MODE } };
}

export function automaticTaskGroupTitleSummary(metadata = {}) {
  const titleMetadata = metadata?.taskGroupTitle;
  if (!titleMetadata || titleMetadata.mode !== AUTO_TITLE_MODE) return '';
  return summarizeTaskGroupObjective(titleMetadata.summary || '');
}

export function compactTaskGroupTitle(group = {}) {
  return automaticTaskGroupTitleSummary(group?.metadata)
    || String(group?.title || '').trim()
    || 'uBuddy 工作群';
}
