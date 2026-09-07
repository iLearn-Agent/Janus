import { escapeAttr, escapeHtml, formatDateTime } from '../utils/format.js';
import { state } from '../state.js';
import { translateUiText } from '../i18n.js';

export function renderAgentWorkStatus(status = {}, { compact = false, lifecycleLabel = '' } = {}) {
  const language = state.languageMode;
  const agentInstanceId = String(status.agentInstanceId || '').trim();
  const availability = status.availability === 'working' ? 'working' : 'idle';
  const availabilityLabel = translateUiText(availability === 'working' ? '工作中' : '空闲', language);
  const workState = String(status.workState || '').trim();
  const currentWork = String(status.currentWork || '').trim();
  const updatedAt = String(status.updatedAt || '').trim();
  const updateLabel = updatedAt ? formatRelativeTime(updatedAt, Date.now(), language) : translateUiText('更新时间未知', language);
  const stateLabel = workStateLabel(workState, language);
  const detailLabel = currentWork || translateUiText(availability === 'idle' ? '可开始新的任务' : '任务信息更新中', language);
  const lifecycleDisplayLabel = translateUiText(lifecycleLabel, language);
  const updateTitle = updatedAt ? formatDateTime(updatedAt) : translateUiText('更新时间未知', language);
  return `<span class="agent-work-status ${compact ? 'is-compact' : ''} is-${escapeAttr(availability)}${workState ? ` state-${escapeAttr(workState)}` : ''}" data-agent-work-status="${escapeAttr(agentInstanceId)}">
    <span class="agent-work-status-main"><i aria-hidden="true"></i><strong>${escapeHtml(availabilityLabel)}</strong>${stateLabel ? `<em>${escapeHtml(stateLabel)}</em>` : ''}${lifecycleDisplayLabel ? `<b>${escapeHtml(lifecycleDisplayLabel)}</b>` : ''}</span>
    ${compact ? '' : `<span class="agent-work-status-detail"><span>${escapeHtml(detailLabel)}</span><time datetime="${escapeAttr(updatedAt)}" title="${escapeAttr(updateTitle)}">${escapeHtml(updateLabel)}</time></span>`}
  </span>`;
}

export function workStateLabel(value = '', language = state.languageMode) {
  return translateUiText(({ reserved: '已预留', queued: '排队中', running: '执行中', blocked: '受阻' })[String(value || '')] || '', language);
}

export function formatRelativeTime(value = '', now = Date.now(), language = state.languageMode) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return translateUiText('更新时间未知', language);
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  const english = language === 'en';
  if (seconds < 45) return english ? 'Updated just now' : '刚刚更新';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return english ? `${minutes}m ago` : `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return english ? `${hours}h ago` : `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return english ? `${days}d ago` : `${days} 天前`;
}
