import { runCodexExec } from '../../../codex.js';
import { normalizeUBuddyTaskIntake, validateUBuddyTaskIntake } from '../../../../shared/contracts/uBuddyTaskIntake.js';

export const UBUDDY_TASK_READINESS_AUDIT_VERSION = 'UBUDDY_TASK_READINESS_AUDIT_V1';
const READINESS_CONTEXT_MESSAGE_LIMIT = 6;
const READINESS_CONTEXT_MESSAGE_CHAR_LIMIT = 1_200;
const READINESS_REQUEST_CHAR_LIMIT = 8_000;

export async function auditUBuddyTaskReadiness({
  prompt = '', intake = null, recentMessages = [], root = '', cwd = '', model = '',
  reasoningEffort = 'low', signal = null, timeoutMs = 180_000, execute = runCodexExec,
  executionContext = null,
} = {}) {
  const normalized = normalizeUBuddyTaskIntake(intake || {});
  const answer = await execute({
    prompt: buildReadinessAuditPrompt({ prompt, intake: normalized, recentMessages }),
    agentId: 'secretary_agent', root, cwd: cwd || root, role: 'ubuddy-task-readiness-audit',
    model, reasoningEffort, sandbox: 'read-only', signal, timeoutMs, harnessMode: 'raw', executionContext,
  });
  const parsed = parseJsonAnswer(answer);
  const parsedClarifications = Array.isArray(parsed.clarifications) ? parsed.clarifications : null;
  const clarifications = normalized.state === 'needs_clarification' && parsedClarifications?.length === 0
    ? normalized.clarifications
    : parsedClarifications || normalized.clarifications;
  const ready = normalized.state === 'ready' && parsed.dispatchReady !== false && !clarifications.length;
  const auditedWorkReportSpec = normalized.taskKind === 'recent_work_report'
    ? { ...(normalized.workReportSpec || {}), ...(parsed.intake?.workReportSpec || parsed.intake?.work_report_spec || {}) }
    : null;
  const auditedIntake = normalizeUBuddyTaskIntake({
    ...normalized,
    ...(parsed.intake || {}),
    ...(normalized.taskKind === 'recent_work_report' ? { workReportSpec: auditedWorkReportSpec } : {}),
    executionPlan: parsed.executionPlan || parsed.intake?.executionPlan || normalized.executionPlan,
    knownFacts: parsed.knownFacts || normalized.knownFacts,
    safeAssumptions: parsed.safeAssumptions || normalized.safeAssumptions,
    criticalUnknowns: parsed.criticalUnknowns || normalized.criticalUnknowns,
    clarifications,
    missingFields: ready ? [] : (() => {
      const auditedFields = (parsed.criticalUnknowns || normalized.criticalUnknowns).map((item) => item.id || item.name).filter(Boolean);
      return auditedFields.length ? auditedFields : normalized.missingFields;
    })(),
    state: ready ? 'ready' : 'needs_clarification',
    readiness: { status: ready ? 'ready' : 'needs_clarification', reason: parsed.reason || '' },
  });
  validateUBuddyTaskIntake(auditedIntake, { throwOnError: true });
  return { version: UBUDDY_TASK_READINESS_AUDIT_VERSION, dispatchReady: ready, intake: auditedIntake, rawAnswer: answer };
}

function buildReadinessAuditPrompt({ prompt, intake, recentMessages }) {
  return [
    `【${UBUDDY_TASK_READINESS_AUDIT_VERSION}】`,
    'You are an independent pre-dispatch readiness auditor. Do not execute work and do not create tasks.',
    'Inspect the proposed execution plan and find every currently identifiable missing fact that would force the executor to guess or materially change the result, scope, recipient, permissions, risk, deliverable, deadline, or acceptance.',
    'Do not ask for optional style preferences when a safe default is available. Record safe defaults explicitly.',
    'Return all independent clarification questions together. Do not limit the result to one question.',
    'If the plan is ready, return dispatchReady=true and clarifications=[]. If not ready, return dispatchReady=false and one question for each independent critical unknown.',
    `Current request:\n${clipText(prompt, READINESS_REQUEST_CHAR_LIMIT)}`,
    `Draft intake:\n${JSON.stringify(intake)}`,
    `Recent context:\n${formatRecentVisibleContext(recentMessages) || 'No recent visible context.'}`,
    'Schema: {"version":"UBUDDY_TASK_READINESS_AUDIT_V1","dispatchReady":true,"reason":"...","executionPlan":{"summary":"...","steps":["..."],"requiredInputs":[{"id":"...","name":"...","reason":"...","source":"owner|context|default","satisfied":true}]},"knownFacts":["..."],"safeAssumptions":["..."],"criticalUnknowns":[{"id":"...","name":"...","reason":"...","questionId":"..."}],"clarifications":[{"id":"...","header":"...","question":"...","reason":"...","answerType":"single_choice","options":[{"label":"...","description":"..."}],"allowOther":true,"required":true}],"intake":{}}',
  ].join('\n\n');
}

function formatRecentVisibleContext(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-READINESS_CONTEXT_MESSAGE_LIMIT)
    .map((message) => {
      const role = String(message?.role || 'user').trim();
      const content = clipText(message?.content || '', READINESS_CONTEXT_MESSAGE_CHAR_LIMIT);
      return content ? `${role}: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function clipText(value = '', limit = 1_000) {
  const text = String(value || '').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function parseJsonAnswer(answer) {
  const text = String(answer || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('uBuddy readiness audit did not return JSON.');
  return JSON.parse(text.slice(start, end + 1));
}
