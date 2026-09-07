import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  createTestDiagnostics,
  diagnosticError,
  installTestFailureHandlers,
  redactDiagnosticValue,
} from './testDiagnostics.mjs';

const REPORT_JSON = 'ubuddy-report.json';
const REPORT_MARKDOWN = 'ubuddy-report.md';
const EVENTS_JSONL = 'ubuddy-events.jsonl';

export function createUBuddyFullChainDiagnostics({ mode = 'fake', env = process.env } = {}) {
  const artifactDir = String(env.JANUS_TEST_ARTIFACT_DIR || '').trim();
  const runId = String(env.JANUS_TEST_RUN_ID || '').trim();
  const caseId = String(env.JANUS_TEST_CASE_ID || 'ubuddy-full-chain').trim();
  const startedAt = new Date().toISOString();
  const scenarios = [];
  const checkpoints = [];
  let activeScenario = null;
  const diagnostics = artifactDir
    ? createTestDiagnostics({ runId, caseId, artifactDir, source: 'ubuddy-full-chain', eventsFileName: EVENTS_JSONL })
    : null;
  const removeFailureHandlers = diagnostics ? installTestFailureHandlers(diagnostics) : () => {};

  const beginScenario = (id, data = undefined) => {
    const cleanId = cleanScenarioId(id);
    if (activeScenario) finishScenario('passed');
    activeScenario = { id: cleanId, status: 'running', startedAt: new Date().toISOString(), startedMs: Date.now() };
    diagnostics?.event('scenario_start', { stepId: cleanId, message: cleanId, data });
    return cleanId;
  };

  const finishScenario = (status = 'passed', data = undefined, error = null) => {
    if (!activeScenario) return null;
    const finished = {
      id: activeScenario.id,
      status,
      startedAt: activeScenario.startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - activeScenario.startedMs),
      ...(data && typeof data === 'object' ? { data } : {}),
      ...(error ? { failure: diagnosticError(error, { env }) } : {}),
    };
    scenarios.push(finished);
    diagnostics?.event(status === 'passed' ? 'scenario_end' : 'scenario_failed', {
      stepId: finished.id,
      level: status === 'passed' ? 'info' : 'error',
      message: finished.id,
      durationMs: finished.durationMs,
      data,
      error: error || undefined,
    });
    activeScenario = null;
    return finished;
  };

  const checkpoint = (id, data = undefined) => {
    const item = { id: cleanScenarioId(id), timestamp: new Date().toISOString(), ...(data ? { data } : {}) };
    checkpoints.push(item);
    diagnostics?.event('checkpoint', { stepId: activeScenario?.id || '', message: item.id, data });
    return item;
  };

  const event = (name, details = {}) => diagnostics?.event(name, details);

  const writeReport = async ({ status = 'passed', error = null, summary = {} } = {}) => {
    if (!artifactDir) return null;
    if (activeScenario) finishScenario(status === 'passed' ? 'passed' : 'failed', undefined, error);
    const endedAt = new Date().toISOString();
    const payload = redactDiagnosticValue({
      schemaVersion: 1,
      reportType: 'ubuddy_full_chain',
      runId,
      caseId,
      mode,
      status,
      startedAt,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      scenarios,
      checkpoints,
      ...summary,
      failure: error ? diagnosticError(error, { env }) : null,
    }, { env });
    diagnostics?.event('report_ready', {
      level: status === 'passed' ? 'info' : 'error',
      message: status,
      durationMs: payload.durationMs,
      data: {
        scenarioCount: scenarios.length,
        checkpointCount: checkpoints.length,
        finalStatus: payload.finalStatus || '',
      },
      error: error || undefined,
    });
    const jsonPath = path.join(artifactDir, REPORT_JSON);
    const markdownPath = path.join(artifactDir, REPORT_MARKDOWN);
    await writeAtomic(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
    await writeAtomic(markdownPath, renderMarkdown(payload));
    return { jsonPath, markdownPath, eventsPath: diagnostics.eventsPath, payload };
  };

  return {
    enabled: Boolean(diagnostics),
    artifactDir,
    beginScenario,
    finishScenario,
    checkpoint,
    event,
    writeReport,
    close: removeFailureHandlers,
  };
}

export async function collectUBuddyFullChainSnapshot({ runtimes = {}, pool = null } = {}) {
  const actors = {};
  for (const [alias, runtime] of Object.entries(runtimes || {})) actors[alias] = collectRuntimeSnapshot(runtime);
  return {
    actors,
    cloud: await collectCloudSnapshot(pool),
    totals: aggregateSnapshotTotals(actors),
  };
}

function collectRuntimeSnapshot(runtime) {
  if (!runtime?.db) return { available: false };
  const delegations = safeAll(runtime.db, `SELECT status,task_run_id,metadata_json,last_error FROM agent_delegations ORDER BY created_at`)
    .map((row) => {
      const metadata = safeJson(row.metadata_json);
      return {
        status: row.status || '',
        hasTaskRun: Boolean(row.task_run_id),
        executionState: metadata.executionState || '',
        deliveryState: metadata.deliveryState || '',
        failureCode: metadata.failureCode || '',
        retryable: Boolean(metadata.retryable),
        attemptTaskRunCount: Array.isArray(metadata.attemptTaskRunIds) ? metadata.attemptTaskRunIds.length : 0,
        generatedFileCount: Array.isArray(metadata.generatedTaskFiles) ? metadata.generatedTaskFiles.length : 0,
        hasPreliminaryResult: Boolean(metadata.preliminaryResult),
        hasLastError: Boolean(row.last_error),
      };
    });
  const taskRuns = safeAll(runtime.db, `SELECT id,status,department_id,lead_agent_id FROM task_runs ORDER BY created_at`);
  const nodes = safeAll(runtime.db, `SELECT task_run_id,status,department_id,agent_id,attempt_count,max_attempts,last_error_code FROM task_nodes ORDER BY created_at`);
  const taskEvents = safeAll(runtime.db, `SELECT event_type,COUNT(*) AS count FROM task_events GROUP BY event_type ORDER BY event_type`);
  const revisions = safeAll(runtime.db, `SELECT revision_type,COUNT(*) AS count FROM task_graph_revisions GROUP BY revision_type ORDER BY revision_type`);
  const modelExecutions = safeAll(runtime.db, `SELECT status,execution_kind,provider_id,effective_model,started_at,completed_at FROM model_executions ORDER BY started_at`);
  return {
    available: true,
    delegations,
    delegationStatusCounts: countBy(delegations, (item) => item.status),
    taskRuns: taskRuns.map((task) => ({
      status: task.status || '',
      departmentId: task.department_id || '',
      leadAgentId: task.lead_agent_id || '',
      nodeStatusCounts: countBy(nodes.filter((node) => node.task_run_id === task.id), (node) => node.status),
      retryCount: nodes.filter((node) => node.task_run_id === task.id).reduce((sum, node) => sum + Math.max(0, Number(node.attempt_count || 0) - 1), 0),
      failureCodes: [...new Set(nodes.filter((node) => node.task_run_id === task.id).map((node) => node.last_error_code).filter(Boolean))],
    })),
    taskEventCounts: Object.fromEntries(taskEvents.map((item) => [item.event_type, Number(item.count || 0)])),
    graphRevisionCounts: Object.fromEntries(revisions.map((item) => [item.revision_type, Number(item.count || 0)])),
    modelExecutions: {
      total: modelExecutions.length,
      statusCounts: countBy(modelExecutions, (item) => item.status),
      kinds: countBy(modelExecutions, (item) => item.execution_kind),
      models: [...new Set(modelExecutions.map((item) => item.effective_model).filter(Boolean))],
      completedWithThreadTiming: modelExecutions.filter((item) => item.status === 'completed' && item.started_at && item.completed_at).length,
    },
  };
}

async function collectCloudSnapshot(pool) {
  if (!pool?.query) return { available: false };
  try {
    const [delegations, revisions, files, groups] = await Promise.all([
      pool.query('SELECT status,COUNT(*) AS count FROM agent_delegations GROUP BY status ORDER BY status'),
      pool.query('SELECT action,COUNT(*) AS count FROM agent_delegation_revisions GROUP BY action ORDER BY action'),
      pool.query('SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM collaboration_files'),
      pool.query('SELECT status,COUNT(*) AS count FROM collaboration_groups GROUP BY status ORDER BY status'),
    ]);
    return {
      available: true,
      delegationStatusCounts: Object.fromEntries(delegations.rows.map((item) => [item.status, Number(item.count || 0)])),
      revisionActionCounts: Object.fromEntries(revisions.rows.map((item) => [item.action, Number(item.count || 0)])),
      collaborationFiles: { count: Number(files.rows[0]?.count || 0), bytes: Number(files.rows[0]?.bytes || 0) },
      groupStatusCounts: Object.fromEntries(groups.rows.map((item) => [item.status, Number(item.count || 0)])),
    };
  } catch (error) {
    return { available: false, error: diagnosticError(error) };
  }
}

function aggregateSnapshotTotals(actors = {}) {
  const values = Object.values(actors).filter((item) => item?.available);
  return {
    localDelegations: values.reduce((sum, item) => sum + item.delegations.length, 0),
    localTaskRuns: values.reduce((sum, item) => sum + item.taskRuns.length, 0),
    modelExecutions: values.reduce((sum, item) => sum + Number(item.modelExecutions?.total || 0), 0),
  };
}

function countBy(items = [], selector) {
  const result = {};
  for (const item of items) {
    const key = String(selector(item) || 'unknown');
    result[key] = Number(result[key] || 0) + 1;
  }
  return result;
}

function safeAll(db, sql) {
  try { return db.prepare(sql).all(); } catch { return []; }
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanScenarioId(value = '') {
  return String(value || 'scenario').trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'scenario';
}

async function writeAtomic(target, content) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, content, 'utf8');
  await fsp.rename(temporary, target);
}

function renderMarkdown(report = {}) {
  const lines = [
    '# uBuddy full-chain diagnostic report',
    '',
    `- Status: **${report.status || 'unknown'}**`,
    `- Mode: ${report.mode || 'unknown'}`,
    `- Duration: ${formatDuration(report.durationMs)}`,
    `- Final group status: ${report.finalStatus || 'not reached'}`,
    `- Scenarios: ${report.scenarios?.filter((item) => item.status === 'passed').length || 0}/${report.scenarios?.length || 0} passed`,
    '',
    '## Scenario timeline',
    '',
    '| Scenario | Status | Duration |',
    '| --- | --- | ---: |',
  ];
  for (const scenario of report.scenarios || []) {
    lines.push(`| ${markdownCell(scenario.id)} | ${markdownCell(scenario.status)} | ${formatDuration(scenario.durationMs)} |`);
  }
  lines.push('', '## Evidence summary', '');
  lines.push(`- Checks: ${(report.checks || []).length}`);
  lines.push(`- Local delegations: ${report.snapshot?.totals?.localDelegations || 0}`);
  lines.push(`- Local task runs: ${report.snapshot?.totals?.localTaskRuns || 0}`);
  lines.push(`- Model executions: ${report.snapshot?.totals?.modelExecutions || 0}`);
  lines.push(`- Cloud collaboration files: ${report.snapshot?.cloud?.collaborationFiles?.count || 0}`);
  if (report.fileTransfer) {
    lines.push(`- Submitted files: ${report.fileTransfer.submitted || 0}`);
    lines.push(`- Uploaded files: ${report.fileTransfer.uploaded || 0}`);
    lines.push(`- Download verified: ${Boolean(report.fileTransfer.downloadVerified)}`);
  }
  if (report.failure) {
    lines.push('', '## Failure', '', `- Scenario: ${report.scenarios?.at(-1)?.id || 'unknown'}`);
    lines.push(`- Code: ${report.failure.code || ''}`);
    lines.push(`- Message: ${report.failure.message || 'unknown error'}`);
  }
  lines.push('', '## Privacy', '', '- Raw prompts, private messages, Memory content, credentials, usernames, absolute paths and databases are not included.', '');
  return `${lines.join('\n')}\n`;
}

function markdownCell(value = '') {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatDuration(value = 0) {
  const milliseconds = Math.max(0, Number(value || 0));
  return milliseconds >= 60_000 ? `${(milliseconds / 60_000).toFixed(1)}m` : `${(milliseconds / 1000).toFixed(1)}s`;
}

export const UBUDDY_FULL_CHAIN_REPORT_FILES = Object.freeze([REPORT_JSON, REPORT_MARKDOWN, EVENTS_JSONL]);
