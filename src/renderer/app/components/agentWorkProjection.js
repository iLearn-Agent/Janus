import { normalizeAgentWorkStatusProjectionEnvelope } from '../../../shared/contracts/uBuddyWorkStatus.js';
import { escapeAttr, escapeHtml, formatDateTime } from '../utils/format.js';
import { formatRelativeTime } from './agentWorkStatus.js';

export function workProjectionEnvelope(value = null) {
  if (!value) return null;
  const envelope = normalizeAgentWorkStatusProjectionEnvelope(value);
  const actors = mergeAgentWorkProjectionActors(envelope.actors);
  return envelope.scopeId && actors.length ? { ...envelope, actors } : null;
}

export function mergeAgentWorkProjectionActors(values = []) {
  const grouped = new Map();
  for (const actor of Array.isArray(values) ? values : []) {
    const key = projectionActorKey(actor);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(actor);
  }
  return [...grouped.values()].map(mergeProjectionActorGroup);
}

export function numberAgentInstanceLabels(items = [], {
  instanceId = (item) => item?.agentInstanceId || '',
  familyId = (item) => item?.agentFamilyId || item?.agentId || '',
  baseName = (item) => item?.familyName || item?.name || item?.actorLabel || item?.agentFamilyId || item?.agentId || 'Agent',
} = {}) {
  const result = (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
  const families = new Map();
  for (const item of result) {
    const resolvedInstanceId = String(instanceId(item) || '').trim();
    const resolvedFamilyId = String(familyId(item) || '').trim();
    const key = resolvedFamilyId || (resolvedInstanceId ? `instance:${resolvedInstanceId}` : `name:${baseName(item)}`);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push({ item, resolvedInstanceId });
  }
  for (const familyItems of families.values()) {
    const uniqueInstances = [...new Set(familyItems.map(({ resolvedInstanceId }) => resolvedInstanceId).filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const familyBaseName = stripInstanceNumber(String(familyItems.find(({ item }) => item?.familyName)?.item?.familyName
      || baseName(familyItems[0]?.item) || 'Agent').trim() || 'Agent');
    for (const { item, resolvedInstanceId } of familyItems) {
      const number = uniqueInstances.length > 1 ? uniqueInstances.indexOf(resolvedInstanceId) + 1 : 0;
      item.displayName = number > 0
        ? `${familyBaseName} #${number}`
        : stripInstanceNumber(String(baseName(item) || familyBaseName).trim() || familyBaseName);
    }
  }
  return result;
}

export function workProjectionForNode(envelopeValue = null, node = {}) {
  const envelope = workProjectionEnvelope(envelopeValue);
  if (!envelope) return null;
  const taskNodeId = String(node.id || node.localId || node.local_id || '').trim();
  const agentInstanceId = String(node.agentInstanceId || node.agent_instance_id || '').trim();
  const agentId = String(node.agentId || node.agent_id || '').trim();
  const nodeActor = envelope.actors.find((actor) => taskNodeId && actor.taskNodeId === taskNodeId) || null;
  if (nodeActor && (!agentInstanceId || !nodeActor.agentInstanceId || nodeActor.agentInstanceId === agentInstanceId)) return nodeActor;
  if (agentInstanceId) return envelope.actors.find((actor) => actor.agentInstanceId === agentInstanceId) || null;
  return envelope.actors.find((actor) => agentId && actor.agentId === agentId && actor.actorKind !== 'ubuddy' && actor.actorKind !== 'remote_ubuddy') || null;
}

export function workProjectionForAgent(envelopeValue = null, { agentInstanceId = '', agentId = '', actorKind = '' } = {}) {
  const envelope = workProjectionEnvelope(envelopeValue);
  if (!envelope) return null;
  const cleanAgentInstanceId = String(agentInstanceId || '').trim();
  if (cleanAgentInstanceId) return envelope.actors.find((actor) => actor.agentInstanceId === cleanAgentInstanceId) || null;
  return envelope.actors.find((actor) => actorKind && actor.actorKind === actorKind)
    || envelope.actors.find((actor) => agentId && actor.agentId === agentId) || null;
}

export function renderAgentWorkProjectionSummary(actor = null, {
  compact = false,
  showTimeline = false,
  leader = false,
  displayName = '',
  nodes = [],
} = {}) {
  if (!actor) return '';
  const progress = actor.progress || { completed: 0, total: 0, percent: null };
  const updatedAt = actor.updatedAt || '';
  const evidence = Array.isArray(actor.evidenceRefs) ? actor.evidenceRefs.slice(0, compact ? 2 : 6) : [];
  const timeline = Array.isArray(actor.timeline) ? actor.timeline.slice(compact ? -1 : -12).reverse() : [];
  const responsibleNodes = uniqueResponsibleNodes(nodes);
  return `<section class="agent-work-projection ${compact ? 'is-compact' : ''} is-${escapeAttr(actor.status || 'idle')}" data-agent-work-projection="${escapeAttr(actor.projectionId || '')}">
    <header><span><i aria-hidden="true"></i><strong>${escapeHtml(displayName || actor.actorLabel || actor.agentId || 'Agent')}</strong>${leader ? '<em>leader</em>' : ''}</span><b>${escapeHtml(workProjectionStatusLabel(actor.status))}</b></header>
    <div class="agent-work-projection-stage"><span>${escapeHtml(workProjectionStageLabel(actor.currentStage))}</span>${progress.total ? `<strong>${progress.completed}/${progress.total} 节点${progress.percent == null ? '' : ` · ${progress.percent}%`}</strong>` : '<strong>进度待更新</strong>'}</div>
    ${responsibleNodes.length ? `<div class="agent-work-projection-nodes"><small>负责节点</small><div>${responsibleNodes.map((node) => `<span class="is-${escapeAttr(node.status || 'pending')}">${escapeHtml(node.title)}</span>`).join('')}</div></div>` : ''}
    ${actor.currentNodeTitle ? `<div class="agent-work-projection-node"><small>当前节点</small><strong>${escapeHtml(actor.currentNodeTitle)}</strong></div>` : ''}
    <p>${escapeHtml(actor.currentAction || defaultProjectionAction(actor.status))}</p>
    ${compact ? '' : `${actor.completedSummary ? `<div class="agent-work-projection-completed"><small>已完成</small><span>${escapeHtml(actor.completedSummary)}</span></div>` : ''}
      ${actor.blocker ? `<div class="agent-work-projection-blocker"><small>阻塞</small><strong>${escapeHtml(actor.blocker.summary || '当前工作暂时无法继续。')}</strong>${actor.blocker.nextRetryAt ? `<span>下次重试：${escapeHtml(formatDateTime(actor.blocker.nextRetryAt))}</span>` : ''}</div>` : ''}
      ${actor.nextStep ? `<div class="agent-work-projection-next"><small>下一步</small><span>${escapeHtml(actor.nextStep)}</span></div>` : ''}
      ${evidence.length ? `<div class="agent-work-projection-evidence"><small>证据 / 交付物</small><div>${evidence.map(renderEvidenceRef).join('')}</div></div>` : ''}
      ${showTimeline && timeline.length ? `<details class="agent-work-projection-timeline"><summary>工作进度时间线 · ${timeline.length}</summary><div>${timeline.map(renderTimelineEntry).join('')}</div></details>` : ''}`}
    <footer><time datetime="${escapeAttr(updatedAt)}" title="${escapeAttr(updatedAt ? formatDateTime(updatedAt) : '更新时间未知')}">${escapeHtml(updatedAt ? formatRelativeTime(updatedAt) : '更新时间未知')}</time></footer>
  </section>`;
}

export function renderAgentWorkProjectionList(envelopeValue = null, {
  leaderAgentInstanceId = '',
  showTimeline = true,
  nodes = [],
  displayNamesByInstanceId = null,
  includeCoordinator = false,
} = {}) {
  const envelope = workProjectionEnvelope(envelopeValue);
  if (!envelope) return '';
  const actors = envelope.actors.filter((actor) => includeCoordinator || !['ubuddy', 'remote_ubuddy'].includes(actor.actorKind))
    .sort((left, right) => {
      const leftName = displayNamesByInstanceId?.get?.(left.agentInstanceId) || left.actorLabel || left.agentId || '';
      const rightName = displayNamesByInstanceId?.get?.(right.agentInstanceId) || right.actorLabel || right.agentId || '';
      return leftName.localeCompare(rightName, 'zh-CN') || left.agentInstanceId.localeCompare(right.agentInstanceId);
    });
  return `<div class="agent-work-projection-list">${actors.map((actor) => renderAgentWorkProjectionSummary(actor, {
    showTimeline,
    leader: Boolean(leaderAgentInstanceId && actor.agentInstanceId === leaderAgentInstanceId),
    displayName: displayNamesByInstanceId?.get?.(actor.agentInstanceId) || '',
    nodes: nodesForProjectionActor(nodes, actor),
  })).join('')}</div>`;
}

export function workProjectionStatusLabel(value = '') {
  return ({ idle: '等待中', reserved: '已预留', queued: '排队中', running: '执行中', waiting: '等待恢复', blocked: '受阻', completed: '已完成', failed: '失败', cancelled: '已取消' })[value] || value || '状态更新中';
}

export function workProjectionStageLabel(value = '') {
  return ({ planning: '规划', executing: '执行', verifying: '验证', delivering: '交付', completed: '完成', failed: '失败', cancelled: '取消' })[value] || value || '阶段更新中';
}

function renderEvidenceRef(item = {}) {
  const label = item.label || item.id || item.kind || '证据';
  if (item.url && /^https:\/\//i.test(item.url)) {
    return `<a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
  }
  return `<span title="${escapeAttr(item.id || '')}">${escapeHtml(label)}</span>`;
}

function renderTimelineEntry(item = {}) {
  const occurredAt = item.occurredAt || '';
  return `<article class="is-${escapeAttr(item.status || 'recorded')}"><i aria-hidden="true"></i><span><strong>${escapeHtml(item.summary || '工作状态已更新')}</strong><small>${escapeHtml(workProjectionStageLabel(item.stage))}${item.status ? ` · ${escapeHtml(workProjectionStatusLabel(item.status))}` : ''}</small></span><time title="${escapeAttr(occurredAt ? formatDateTime(occurredAt) : '')}">${escapeHtml(occurredAt ? formatRelativeTime(occurredAt) : '')}</time></article>`;
}

function defaultProjectionAction(status = '') {
  return ({ idle: '等待上游依赖或新的工作要求。', reserved: '任务已预留，等待开始执行。', queued: '任务已进入 FIFO 队列。', running: '正在处理当前任务节点。', waiting: '等待所需信息或自动重试。', blocked: '当前工作存在阻塞。', completed: '负责的工作已经完成。', failed: '负责的工作执行失败。', cancelled: '负责的工作已经取消。' })[status] || '工作状态正在更新。';
}

function projectionActorKey(actor = {}) {
  const actorKind = String(actor.actorKind || '').trim();
  const agentInstanceId = String(actor.agentInstanceId || '').trim();
  if (['ubuddy', 'remote_ubuddy'].includes(actorKind)) return `coordinator:${actorKind}`;
  if (agentInstanceId) return `instance:${agentInstanceId}`;
  return String(actor.projectionId || '').trim() ? `projection:${actor.projectionId}` : '';
}

function mergeProjectionActorGroup(values = []) {
  const revisions = new Map();
  for (const actor of values) {
    const key = String(actor.projectionId || '').trim() || `anonymous:${revisions.size}`;
    const current = revisions.get(key);
    if (!current || compareProjectionRecency(actor, current) < 0) revisions.set(key, actor);
  }
  const actors = [...revisions.values()];
  const primary = actors.slice().sort(compareProjectionRecency)[0] || {};
  const timeline = uniqueLatestBy(actors.flatMap((actor) => actor.timeline || []),
    (item) => item.id || `${item.occurredAt}:${item.summary}`,
    (item) => Date.parse(item.occurredAt || '') || 0)
    .sort((left, right) => Date.parse(left.occurredAt || '') - Date.parse(right.occurredAt || ''))
    .slice(-50);
  const evidenceRefs = uniqueBy(actors.flatMap((actor) => actor.evidenceRefs || []), (item) => `${item.kind || ''}:${item.id || item.url || item.label || ''}`)
    .slice(0, 30);
  return {
    ...primary,
    actorLabel: preferredProjectionLabel(actors.map((actor) => actor.actorLabel), primary.actorLabel),
    completedSummary: uniqueText(actors.map((actor) => actor.completedSummary)).join('；'),
    evidenceRefs,
    timeline,
    sourceRevision: Math.max(0, ...actors.map((actor) => Number(actor.sourceRevision || 0))),
    updatedAt: actors.map((actor) => actor.updatedAt).filter(Boolean).sort().at(-1) || primary.updatedAt || '',
  };
}

function compareProjectionRecency(left = {}, right = {}) {
  const statusPriority = { running: 0, blocked: 1, waiting: 2, queued: 3, reserved: 4, failed: 5, idle: 6, completed: 7, cancelled: 8 };
  return projectionTime(right) - projectionTime(left)
    || Number(right.sourceRevision || 0) - Number(left.sourceRevision || 0)
    || (statusPriority[left.status] ?? 9) - (statusPriority[right.status] ?? 9);
}

function projectionTime(actor = {}) {
  return Date.parse(actor.updatedAt || '') || 0;
}

function nodesForProjectionActor(nodes = [], actor = {}) {
  return (Array.isArray(nodes) ? nodes : []).filter((node) => {
    const instanceId = String(node.agentInstanceId || node.agent_instance_id || '').trim();
    if (actor.agentInstanceId) return instanceId === actor.agentInstanceId;
    return !instanceId && actor.agentId && String(node.agentId || node.agent_id || '').trim() === actor.agentId;
  });
}

function uniqueResponsibleNodes(nodes = []) {
  return uniqueBy((Array.isArray(nodes) ? nodes : []).map((node) => ({
    id: String(node.id || node.localId || node.local_id || '').trim(),
    title: String(node.title || '任务节点').trim(),
    status: String(node.status || 'pending').trim(),
  })), (node) => node.id || node.title).slice(0, 12);
}

function uniqueBy(items = [], keyFor) {
  const map = new Map();
  for (const item of items.filter(Boolean)) {
    const key = keyFor(item);
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function uniqueLatestBy(items = [], keyFor, revisionFor) {
  const map = new Map();
  for (const item of items.filter(Boolean)) {
    const key = keyFor(item);
    const current = map.get(key);
    if (!current || revisionFor(item) >= revisionFor(current)) map.set(key, item);
  }
  return [...map.values()];
}

function uniqueText(items = []) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function stripInstanceNumber(value = '') {
  return String(value || '').replace(/\s+#\d+$/u, '').trim() || 'Agent';
}

function preferredProjectionLabel(values = [], fallback = '') {
  const labels = values.map((value) => String(value || '').trim()).filter(Boolean);
  return labels.find((label) => !/(?:recovery|recover|恢复|会话|conversation)/i.test(label)) || String(fallback || '').trim();
}
