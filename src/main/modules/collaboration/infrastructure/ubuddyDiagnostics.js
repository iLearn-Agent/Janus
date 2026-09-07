import {
  appendDiagnosticEvent,
  testDiagnosticFile,
} from '../../../../shared/diagnostics.js';
import { getApplicationLogger } from '../../../../shared/logging/index.js';

const runtimeLogger = getApplicationLogger('ubuddy-runtime');

export function createUBuddyDiagnosticEmitter({ source = 'ubuddy-runtime', env = process.env } = {}) {
  const filePath = testDiagnosticFile('ubuddy-events.jsonl', env);
  const logger = getApplicationLogger(source);
  return (event, {
    level = 'info', message = '', data = undefined, error = undefined, durationMs = undefined, stepId = '',
  } = {}) => {
    const cleanData = sanitizeUBuddyDiagnosticData(data);
    const details = {
      message: String(message || event || 'ubuddy_event'),
      data: cleanData,
      error,
      durationMs,
      context: stepId ? { stepId } : undefined,
    };
    const logged = logger[level]?.(String(event || 'ubuddy_event'), details) ?? logger.info(String(event || 'ubuddy_event'), details);
    const tested = filePath ? appendDiagnosticEvent(filePath, {
      source,
      level,
      event: String(event || 'ubuddy_event'),
      message: String(message || event || 'ubuddy_event'),
      data: cleanData,
      error,
      durationMs,
      stepId,
    }, { env }) : false;
    return Boolean(logged || tested);
  };
}

export function createUBuddyDiagnosticReport({ store, userId = '', workspaceId = '', taskRunId = '' } = {}) {
  const taskSummaries = store?.listTaskRuns?.({ userId, limit: 100 }) || [];
  const tasks = taskSummaries
    .filter((task) => !taskRunId || task.id === taskRunId)
    .map((task) => store.getTaskRun?.(task.id) || task)
    .filter(Boolean);
  const routeRows = safeAll(store?.db, `SELECT id,session_id,conversation_id,metadata_json,created_at
    FROM messages WHERE metadata_json LIKE '%uBuddyRoute%' ORDER BY created_at DESC LIMIT 100`);
  const sessions = safeAll(store?.db, `SELECT id,conversation_id,account_workspace_id,agent_instance_id,project_id,
    conversation_role,write_state,status FROM sessions ORDER BY updated_at DESC LIMIT 200`);
  const taskWorkspaces = safeAll(store?.db, `SELECT id,delegation_id,task_run_id,group_id,owner_user_id,conversation_id,
    account_workspace_id,status FROM task_workspaces ORDER BY updated_at DESC LIMIT 200`);
  const report = {
    schemaVersion: 1,
    reportType: 'ubuddy_system_diagnostic',
    generatedAt: new Date().toISOString(),
    workspaceId: String(workspaceId || ''),
    taskLifecycle: tasks.map((task) => ({
      taskRunId: task.id,
      status: task.status,
      nodeStatusCounts: countBy(task.nodes || [], (node) => node.status),
      events: (task.events || []).slice(-100).map((event) => ({
        eventId: event.id || event.eventId || '',
        eventType: event.eventType || '',
        nodeId: event.taskNodeId || event.nodeId || '',
        status: event.status || '',
        createdAt: event.createdAt || '',
      })),
      featureFlagSnapshot: task.metadata?.featureFlagSnapshot || null,
    })),
    routeTransitions: routeRows.map((row) => {
      const metadata = safeJson(row.metadata_json);
      const route = metadata.uBuddyRoute || {};
      return {
        messageId: row.id,
        sessionId: row.session_id || '',
        conversationId: row.conversation_id || '',
        mode: route.mode || '',
        source: route.source || '',
        reasonCode: route.reasonCode || '',
        strategyVersion: route.strategyVersion || '',
        createdAt: row.created_at || '',
      };
    }),
    conversationBindings: {
      sessions: sessions.map((row) => ({
        sessionId: row.id,
        conversationId: row.conversation_id || '',
        workspaceId: row.account_workspace_id || '',
        agentInstanceId: row.agent_instance_id || '',
        projectBound: Boolean(row.project_id),
        role: row.conversation_role || '',
        writeState: row.write_state || '',
        status: row.status || '',
      })),
      taskWorkspaces: taskWorkspaces.map((row) => ({
        taskWorkspaceId: row.id,
        delegationId: row.delegation_id || '',
        taskRunId: row.task_run_id || '',
        groupId: row.group_id || '',
        conversationId: row.conversation_id || '',
        workspaceId: row.account_workspace_id || '',
        status: row.status || '',
      })),
    },
    deliverableValidation: tasks.map((task) => ({
      taskRunId: task.id,
      taskStatus: task.status,
      contractVersion: task.metadata?.deliverableContractVersion || task.metadata?.deliverableContract?.version || '',
      validationMode: task.metadata?.deliverableValidationMode || 'legacy_compatible',
      validationState: task.metadata?.deliveryValidationState || '',
      resultState: task.metadata?.resultState || task.metadata?.deliverableResult?.resultState || '',
      failureCode: task.metadata?.deliveryValidationCode || task.metadata?.deliverableResult?.failureCode || '',
      fileCount: task.metadata?.deliverableResult?.files?.length || 0,
    })),
  };
  return sanitizeUBuddyDiagnosticData(report);
}

export function emitUBuddyDiagnosticReport(options = {}) {
  const report = createUBuddyDiagnosticReport(options);
  runtimeLogger.info('ubuddy_diagnostic_report', {
    message: 'uBuddy system diagnostic report',
    data: report,
  });
  return report;
}

export function sanitizeUBuddyDiagnosticData(value = undefined) {
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (UBUDDY_PRIVATE_DIAGNOSTIC_KEYS.has(normalizeKey(key))) continue;
    if (Array.isArray(item)) clean[key] = item.slice(0, 100).map((entry) => sanitizeUBuddyDiagnosticData(entry));
    else if (item && typeof item === 'object') clean[key] = sanitizeUBuddyDiagnosticData(item);
    else clean[key] = item;
  }
  return clean;
}

const UBUDDY_PRIVATE_DIAGNOSTIC_KEYS = new Set([
  'content', 'prompt', 'instruction', 'objective', 'result', 'answer', 'preliminaryresult', 'intakesummary',
  'memory', 'memorycontent', 'workspaceexecutionerror', 'taskworkspaceroot', 'path', 'sourcepath', 'source_path',
  'filename', 'name', 'email', 'username', 'phone', 'identifier', 'authorization', 'token', 'password', 'apikey',
]);

function normalizeKey(value = '') {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function safeAll(db, sql) {
  if (!db?.prepare) return [];
  try { return db.prepare(sql).all(); } catch { return []; }
}

function safeJson(value) {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function countBy(items, selector) {
  const result = {};
  for (const item of items || []) {
    const key = String(selector(item) || 'unknown');
    result[key] = Number(result[key] || 0) + 1;
  }
  return result;
}
