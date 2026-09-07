import crypto from 'node:crypto';

import { validateWorkReportSpec } from '../../../../shared/contracts/workDigest.js';
import { projectTaskAgentWorkStatus } from '../domain/agentWorkStatusProjection.js';

const ACTIVE_STATUSES = new Set(['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'blocked', 'retry_wait']);

export function collectRecentWork({ store, userId = '', workspaceId = '', spec = {}, excludeTaskRunIds = [] } = {}) {
  if (!store || !userId) throw collectorError('recent_work_owner_required');
  const validated = validateWorkReportSpec(spec, { throwOnError: true }).value;
  const allWorkspaces = validated.workspaceScope !== 'current_workspace';
  const authorizedWorkspaceIds = new Set((store.listAccountWorkspaces?.({ userId }) || [])
    .map((item) => String(item.id || item.workspaceId || '')).filter(Boolean));
  if (!authorizedWorkspaceIds.size && workspaceId) authorizedWorkspaceIds.add(String(workspaceId));
  const tasks = store.listTaskRuns({ userId, workspaceId, allWorkspaces, limit: 500 })
    .filter((task) => authorizedWorkspaceIds.has(String(task.workspaceId || task.accountWorkspaceId || '')));
  const excluded = new Set((Array.isArray(excludeTaskRunIds) ? excludeTaskRunIds : []).map(String));
  const start = Date.parse(validated.startAt);
  const end = Date.parse(validated.endAt);
  const evidence = [];
  let filteredPrivateEventCount = 0;
  for (const taskSummary of tasks) {
    if (excluded.has(String(taskSummary.id || ''))) continue;
    if (validated.workspaceScope === 'selected_projects'
      && !validated.projectIds.includes(String(taskSummary.metadata?.projectId || ''))) continue;
    const task = store.getTaskRun(taskSummary.id) || taskSummary;
    if (validated.agentInstanceIds.length) {
      const taskAgentInstanceIds = new Set([
        task.leadAgentInstanceId,
        ...(task.nodes || []).map((node) => node.agentInstanceId),
      ].map(String).filter(Boolean));
      if (!validated.agentInstanceIds.some((id) => taskAgentInstanceIds.has(id))) continue;
    }
    const safeEvents = (task.events || []).filter((event) => safeEvent(event));
    filteredPrivateEventCount += Math.max(0, (task.events || []).length - safeEvents.length);
    const activityTimes = [task.createdAt, task.updatedAt, task.completedAt,
      ...(task.nodes || []).flatMap((node) => [node.createdAt, node.updatedAt, node.startedAt, node.completedAt]),
      ...safeEvents.flatMap((event) => [event.createdAt, event.updatedAt]),
    ].map(timestamp).filter(Number.isFinite);
    const inWindow = activityTimes.some((value) => value >= start && value <= end);
    const activeAtEnd = ACTIVE_STATUSES.has(String(task.status || ''))
      && timestamp(task.createdAt) <= end && (!timestamp(task.completedAt) || timestamp(task.completedAt) > end);
    if (!inWindow && !activeAtEnd) continue;
    const projection = projectTaskAgentWorkStatus({ ...task, events: safeEvents });
    const actors = projection?.actors || [];
    const completed = (task.nodes || []).filter((node) => node.status === 'completed');
    const active = (task.nodes || []).filter((node) => ACTIVE_STATUSES.has(String(node.status || '')));
    const blockerNodes = (task.nodes || []).filter((node) => ['waiting', 'blocked', 'retry_wait', 'failed'].includes(String(node.status || '')));
    const occurredAt = newestIso(activityTimes.filter((value) => value <= end));
    const summaries = completed.slice(-3).map((node) => safeText(node.resultSummary || node.title, 400)).filter(Boolean);
    const currentActions = actors.map((actor) => safeText(actor.currentAction, 300)).filter(Boolean).slice(0, 4);
    const sourceRevision = String(task.updatedAt || occurredAt || task.id);
    evidence.push({
      id: stableEvidenceId('task_run', task.id, sourceRevision), sourceKind: 'task_run', sourceId: task.id,
      sourceRevision, workspaceId: task.workspaceId || task.accountWorkspaceId || taskSummary.workspaceId || '',
      projectId: task.metadata?.projectId || '', agentId: task.leadAgentId || actors.find((actor) => actor.agentId)?.agentId || '',
      agentInstanceId: task.leadAgentInstanceId || actors.find((actor) => actor.agentInstanceId)?.agentInstanceId || '',
      occurredAt, title: safeText(task.title || '任务', 300), status: safeStatus(task.status),
      summary: safeText(summaries.join('；') || currentActions.join('；') || task.summary || task.title, 1200),
      blocker: safeText(blockerNodes.slice(0, 3).map((node) => node.waitReason || node.errorText || `${node.title}受阻`).join('；'), 600),
      nextStep: safeText(actors.map((actor) => actor.nextStep).filter(Boolean).slice(0, 3).join('；')
        || active.slice(0, 3).map((node) => node.title).join('；'), 600),
      artifacts: safeArtifactLabels(task), included: true,
    });
  }
  evidence.sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)) || left.id.localeCompare(right.id));
  const unique = [...new Map(evidence.map((item) => [`${item.sourceKind}:${item.sourceId}`, item])).values()].slice(0, 500);
  const coverage = {
    version: 1, startAt: validated.startAt, endAt: validated.endAt, timezone: validated.timezone,
    workspaceScope: validated.workspaceScope, scannedTaskCount: tasks.length, includedTaskCount: unique.length,
    agentCount: new Set(unique.map((item) => item.agentInstanceId || item.agentId).filter(Boolean)).size,
    workspaceCount: new Set(unique.map((item) => item.workspaceId).filter(Boolean)).size,
    filteredPrivateEventCount, sourceTypes: ['structured_tasks'], complete: true,
  };
  return { spec: validated, evidence: unique, coverage };
}

export function buildDeterministicWorkDigest({ evidence = [], coverage = {}, spec = {} } = {}) {
  const items = (Array.isArray(evidence) ? evidence : []).filter((item) => item.included !== false);
  if (!items.length) return buildEmptyWorkDigest({ coverage, spec });
  const sections = [];
  const completed = items.filter((item) => ['completed', 'result_accepted', 'closed'].includes(item.status));
  const active = items.filter((item) => !completed.includes(item) && !['failed', 'cancelled'].includes(item.status));
  const blocked = items.filter((item) => item.blocker);
  if (completed.length) sections.push(`已完成\n${completed.map(digestLine).join('\n')}`);
  if (active.length) sections.push(`进行中\n${active.map(digestLine).join('\n')}`);
  if (blocked.length) sections.push(`阻塞事项\n${blocked.map((item) => `- ${item.title}：${item.blocker}`).join('\n')}`);
  const next = items.filter((item) => item.nextStep);
  if (next.length) sections.push(`下一步\n${next.map((item) => `- ${item.title}：${item.nextStep}`).join('\n')}`);
  return `${workDigestHeader(spec, coverage)}\n\n${sections.join('\n\n')}\n\n${coverageLine(coverage)}`.slice(0, 12000);
}

export function buildEmptyWorkDigest({ coverage = {}, spec = {} } = {}) {
  return `${workDigestHeader(spec, coverage)}\n\n在上述范围内未找到可汇报的结构化 Janus 工作记录。`;
}

export function buildTimedOutEmptyWorkDigest({ coverage = {}, spec = {} } = {}) {
  return `${buildEmptyWorkDigest({ coverage, spec })}\n\n这只表示系统未检索到结构化记录，不代表本人确认没有开展其他工作。\n\n${coverageLine(coverage)}`;
}

function digestLine(item) {
  return `- ${item.title}：${item.summary || statusLabel(item.status)}${item.artifacts?.length ? `（产物：${item.artifacts.join('、')}）` : ''}`;
}

function workDigestHeader(spec = {}, coverage = {}) {
  return `近期工作汇报（${String(spec.startAt || coverage.startAt || '').slice(0, 10)} 至 ${String(spec.endAt || coverage.endAt || '').slice(0, 10)}）`;
}

function coverageLine(coverage = {}) {
  return `覆盖说明：检索 ${Number(coverage.scannedTaskCount || 0)} 个任务，纳入 ${Number(coverage.includedTaskCount || 0)} 个任务，来源仅包含结构化 Janus 任务记录。`;
}

function safeArtifactLabels(task = {}) {
  const values = [];
  for (const file of task.metadata?.deliverableResult?.files || []) values.push(file.relative_path || file.relativePath || file.name || file.filename);
  for (const submission of task.deliverySubmissions || []) {
    for (const file of submission.artifactManifest || []) values.push(file.relativePath || file.relative_path || file.name || file.filename);
  }
  return [...new Set(values.map((value) => String(value || '').split(/[\\/]/).at(-1)).filter(Boolean))].slice(0, 20);
}

function safeEvent(event = {}) {
  const type = String(event.eventType || '').toLowerCase();
  const activityType = String(event.payload?.activityType || '').toLowerCase();
  return activityType !== 'reasoning' && !/prompt|protocol|raw_response|model_input|memory/i.test(type);
}

function safeStatus(status = '') {
  return ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'blocked', 'retry_wait', 'completed', 'failed', 'cancelled', 'result_accepted', 'closed']
    .includes(String(status || '')) ? String(status || '') : 'pending';
}

function statusLabel(status = '') {
  return ({ completed: '已完成', running: '进行中', queued: '等待执行', waiting: '等待信息', blocked: '当前受阻', failed: '执行失败' })[status] || status;
}

function safeText(value = '', maximum = 600) {
  return String(value || '').replace(/(?:[A-Za-z]:)?[\\/](?:[^\s:]+[\\/])+[^\s:]+/g, '[本地路径已隐藏]')
    .replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function stableEvidenceId(kind, id, revision) {
  return `work_evidence_${crypto.createHash('sha256').update(`${kind}:${id}:${revision}`).digest('hex').slice(0, 32)}`;
}

function timestamp(value = '') {
  const result = Date.parse(String(value || ''));
  return Number.isFinite(result) ? result : NaN;
}

function newestIso(values = []) {
  const value = values.filter(Number.isFinite).sort((a, b) => b - a)[0];
  return Number.isFinite(value) ? new Date(value).toISOString() : '';
}

function collectorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
