import crypto from 'node:crypto';

import { diagnoseEvolutionEvidence } from './diagnosis.js';

const ALLOWED_MEMORY_SECTIONS = new Set([
  'Stable Learnings', 'Reusable Preferences', 'Failure Modes', 'Workflow Notes', 'Topic Files', 'Do Not Store',
]);
const ALLOWED_MEMORY_OPERATIONS = new Set(['add', 'replace', 'remove']);
const EVOLUTION_PRIVATE_PATTERN = /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{7,}\d|(?:email|e-mail|phone|mobile|wechat|微信|邮箱|电话|手机号|联系人)\s*[:：=]|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|authorization|cookie|私钥|密码|密钥|令牌)\s*[:：=]|(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|private|mnt|opt|srv|etc)\/)|https?:\/\/|\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b|\b(?:ghp|github_pat|xox[baprs]|AKIA)[A-Za-z0-9_-]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b|\b(?:user|uagent|session|task|msg|memdoc|memdocver|evidence|cohort|candidate|run|delegation|group|project|instance)_[0-9a-z-]{6,}\b)/gi;
export const EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION = 'cloud_evidence_validation_v3';
const STRUCTURED_EVIDENCE_PRIVACY_SOURCES = new Set(['model_execution', 'model_execution_metric']);
const STRUCTURED_EVIDENCE_INTERNAL_REFERENCE_KEYS = new Set([
  'id', 'ownerUserId', 'owner_user_id', 'projectId', 'project_id', 'conversationId', 'conversation_id',
  'sessionId', 'session_id', 'agentFamilyId', 'agent_family_id',
  'requestMessageId', 'request_message_id', 'responseMessageId', 'response_message_id',
  'taskId', 'task_id', 'taskRunId', 'task_run_id', 'taskNodeId', 'task_node_id', 'contextSpaceId', 'context_space_id',
  'delegationId', 'delegation_id', 'agentInstanceId', 'agent_instance_id',
  'userAgentInstanceId', 'user_agent_instance_id', 'sourceId', 'source_id', 'sourceVersionId', 'source_version_id',
  'sourceHash', 'source_hash', 'eventKind', 'event_kind', 'occurredAt', 'occurred_at',
  'createdAt', 'created_at', 'updatedAt', 'updated_at', 'startedAt', 'started_at', 'completedAt', 'completed_at',
]);

export async function runPersonalEvolutionCore({
  subject = {},
  evidenceSnapshot = [],
  baseSkill = '',
  personalOverlay = '',
  memoryDocuments = [],
  modelExecutor,
  reviewerType = 'general_agent_evaluator',
  holdoutCases = [],
  algorithmVersion = 'personal_cloud_authority_v1',
} = {}) {
  if (typeof modelExecutor !== 'function') throw new Error('Evolution core requires a model executor.');
  const diagnosis = diagnoseEvolutionEvidence({
    agentFamilyId: subject.agentFamilyId,
    departmentId: subject.departmentId,
    evidence: evidenceSnapshot,
  });
  let proposal = await propose({ subject, diagnosis, evidenceSnapshot, baseSkill, personalOverlay, memoryDocuments, modelExecutor, algorithmVersion });
  let gate = validateProposal(proposal, { diagnosis, memoryDocuments });
  if (gate.status !== 'passed') return rejectedResult({ diagnosis, proposal, gate, reason: 'gate_rejected' });
  let review = await reviewProposal({ subject, diagnosis, proposal, gate, reviewerType, modelExecutor });
  let revisionCount = 0;
  if (review.decision === 'partial') {
    revisionCount = 1;
    proposal = await reviseProposal({ subject, diagnosis, proposal, review, modelExecutor });
    gate = validateProposal(proposal, { diagnosis, memoryDocuments });
    if (gate.status !== 'passed') return rejectedResult({ diagnosis, proposal, gate, review, revisionCount, reason: 'revised_gate_rejected' });
    review = await reviewProposal({ subject, diagnosis, proposal, gate, reviewerType, modelExecutor });
  }
  if (review.decision !== 'full') return rejectedResult({ diagnosis, proposal, gate, review, revisionCount, reason: 'review_rejected' });
  const evaluations = await evaluateCandidate({
    subject, proposal, baseSkill, personalOverlay, memoryDocuments, holdoutCases, modelExecutor,
  });
  if (evaluations.regressionCount > 0 || evaluations.caseCount === 0) {
    return rejectedResult({ diagnosis, proposal, gate, review, revisionCount, evaluations, reason: 'regression_rejected' });
  }
  return {
    status: 'approved',
    diagnosis,
    proposal,
    gate,
    review,
    revisionCount,
    evaluations,
    candidateOverlay: String(proposal.overlay_text || '').trim(),
    memoryOperations: normalizeMemoryOperations(proposal.memory_operations, memoryDocuments),
  };
}

async function propose({ subject, diagnosis, evidenceSnapshot, baseSkill, personalOverlay, memoryDocuments, modelExecutor, algorithmVersion }) {
  const raw = await modelExecutor({
    kind: 'personal_proposal',
    modelRole: 'proposer',
    subject,
    prompt: `Return JSON only with summary, overlay_text, memory_operations, eval_cases, and risks.\nAlgorithm: ${algorithmVersion}\nAgent: ${subject.agentFamilyId}\nBase Skill:\n${clip(baseSkill, 12000)}\nCurrent personal Overlay:\n${clip(personalOverlay, 6000)}\nAllowed Memory documents:\n${memoryDocuments.length ? memoryDocuments.map((item) => `${item.id}: ${clip(item.content, 2500)}`).join('\n') : '(none; memory_operations MUST be an empty array)'}\nDiagnosis:\n${JSON.stringify(diagnosis)}\nEvidence:\n${evidenceSnapshot.slice(-60).map((item, index) => `${index + 1}. ${item.role || item.sourceKind}: ${clip(item.content, 1400)}`).join('\n')}\nRules: mutate only this personal Overlay; overlay_text must be plain reusable instructions without Markdown headings, explicitly address the diagnosis recommendation, and include at least one exact substantive term from this recommendation: ${String(diagnosis.recommendation || diagnosis.primary_layer || '')}; every instruction must have an objective trigger and action, preserve user-requested minimal or strict output formats, and keep verification checklists internal unless the user asks to see them; avoid subjective wording such as when useful, when compatible, clearly, or adequately; never include identities, credentials, paths, URLs, or project-specific facts; memory_operations may target only an ID listed above and must use section_name Stable Learnings, Reusable Preferences, Failure Modes, Workflow Notes, Topic Files, or Do Not Store with operation_type add, replace, or remove; include 1-5 evaluation cases and risks.`,
  });
  return parseJsonObject(raw, 'Personal evolution proposer returned invalid JSON.');
}

export function validateProposal(proposal = {}, { diagnosis = {}, memoryDocuments = [] } = {}) {
  const reasons = [];
  let score = 1;
  const overlay = String(proposal.overlay_text || '').trim();
  if (!overlay) reasons.push('Personal Overlay is empty.');
  if (overlay.length > 12000) reasons.push('Personal Overlay exceeds 12000 characters.');
  if (/^#\s+/m.test(overlay)) reasons.push('Personal Overlay may not replace the full Skill.');
  if (/(AGENTS\.md|config\.toml|\$CODEX_HOME|another agent|其他 Agent)/i.test(overlay)) reasons.push('Personal Overlay exceeds its mutation boundary.');
  const allowedIds = new Set(memoryDocuments.map((item) => item.id));
  for (const operation of proposal.memory_operations || []) {
    if (!allowedIds.has(operation.memory_document_id)) reasons.push('Memory operation targets an unauthorized document.');
    if (!ALLOWED_MEMORY_SECTIONS.has(operation.section_name)) reasons.push('Memory operation targets an unsupported section.');
    if (!ALLOWED_MEMORY_OPERATIONS.has(operation.operation_type)) reasons.push('Memory operation type is invalid.');
  }
  const privacyFindings = evolutionPrivacyFindings(proposal);
  if (privacyFindings.length) {
    reasons.push('Proposal contains private or credential-like material.');
  }
  if (!(proposal.eval_cases || []).length) reasons.push('Proposal has no evaluation cases.');
  if (!(proposal.risks || []).length) reasons.push('Proposal has no risk analysis.');
  const diagnosisTerms = String(diagnosis.recommendation || diagnosis.primary_layer || '').toLowerCase().match(/[a-z]{4,}|[\u4e00-\u9fff]{2,}/g) || [];
  const aligned = diagnosis.primary_layer === 'skill_procedure'
    || diagnosisTerms.some((term) => overlay.toLowerCase().includes(term));
  if (!aligned) { reasons.push('Overlay has weak diagnosis alignment.'); score -= 0.08; }
  score -= Math.min(0.8, reasons.length * 0.16);
  score = Math.max(0, Number(score.toFixed(3)));
  return {
    status: reasons.length === 0 && score >= 0.72 ? 'passed' : 'failed',
    score,
    minScore: 0.72,
    reasons,
    diagnosticAlignment: aligned,
    privacyReport: { flagCount: privacyFindings.length, flags: privacyFindings.map(() => 'redaction_required') },
  };
}

async function reviewProposal({ subject, diagnosis, proposal, gate, reviewerType, modelExecutor }) {
  const raw = await modelExecutor({
    kind: 'personal_review',
    modelRole: reviewerType,
    subject,
    prompt: `Review this private personal Agent evolution Proposal. Return JSON only: {"decision":"full|partial|reject","rationale":"","required_revision":"","risks":[]}. Reject private facts, cross-Agent changes, weak evidence, role expansion, or untestable rules.\nReviewer: ${reviewerType}\nDiagnosis: ${JSON.stringify(diagnosis)}\nGate: ${JSON.stringify(gate)}\nProposal: ${JSON.stringify(proposal)}`,
  });
  const parsed = parseJsonObject(raw, 'Personal evolution reviewer returned invalid JSON.');
  const decision = ['full', 'partial', 'reject'].includes(parsed.decision) ? parsed.decision : 'reject';
  return { decision, rationale: String(parsed.rationale || ''), requiredRevision: String(parsed.required_revision || ''), risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 12) : [] };
}

async function reviseProposal({ subject, diagnosis, proposal, review, modelExecutor }) {
  const raw = await modelExecutor({
    kind: 'personal_revision',
    modelRole: 'proposer',
    subject,
    prompt: `Revise the JSON personal evolution Proposal exactly once. Return the same JSON shape only. Preserve safe content and address every reviewer requirement with objective, testable triggers and actions. Preserve strict/minimal user output formats and keep internal verification steps hidden unless requested. Avoid subjective wording.\nDiagnosis: ${JSON.stringify(diagnosis)}\nReviewer: ${JSON.stringify(review)}\nPrevious Proposal: ${JSON.stringify(proposal)}`,
  });
  return parseJsonObject(raw, 'Personal evolution revision returned invalid JSON.');
}

async function evaluateCandidate({ subject, proposal, baseSkill, personalOverlay, memoryDocuments, holdoutCases, modelExecutor }) {
  const proposedCases = (proposal.eval_cases || []).map((item) => ({ input: item.input || item.inputText || '', expected: item.expected || item.expectedText || '' }));
  const cases = (holdoutCases.length ? holdoutCases : proposedCases).filter((item) => item.input).slice(0, 8);
  const effectiveBefore = compileSkill(baseSkill, personalOverlay);
  const effectiveAfter = compileSkill(baseSkill, proposal.overlay_text);
  const memory = memoryDocuments.map((item) => item.content || '').join('\n\n');
  const results = [];
  for (const [index, item] of cases.entries()) {
    const before = await modelExecutor({ kind: 'personal_replay_before', modelRole: 'candidate', subject, prompt: replayPrompt(item, effectiveBefore, memory) });
    const after = await modelExecutor({ kind: 'personal_replay_after', modelRole: 'candidate', subject, prompt: replayPrompt(item, effectiveAfter, memory) });
    const judgeRaw = await modelExecutor({
      kind: 'personal_replay_judge', modelRole: 'reviewer', subject,
      prompt: `Return JSON only: {"winner":"before|after|tie","before_score":0,"after_score":0,"rationale":""}. Compare outputs for the same hidden evaluation. The candidate passes only when it is not worse and follows the expected behavior.\nInput: ${item.input}\nExpected: ${item.expected}\nBefore: ${clip(before, 6000)}\nAfter: ${clip(after, 6000)}`,
    });
    const judge = parseJsonObject(judgeRaw, 'Personal evolution replay judge returned invalid JSON.');
    const regression = judge.winner === 'before' || Number(judge.after_score || 0) + 0.001 < Number(judge.before_score || 0);
    results.push({ caseIndex: index, input: item.input, expected: item.expected, before: clip(before, 8000), after: clip(after, 8000), judge, regression });
  }
  return {
    caseCount: results.length,
    regressionCount: results.filter((item) => item.regression).length,
    results,
  };
}

function normalizeMemoryOperations(items = [], documents = []) {
  const byId = new Map(documents.map((item) => [item.id, item]));
  return (items || []).slice(0, 20).map((item) => {
    const document = byId.get(item.memory_document_id);
    return {
      memoryDocumentId: item.memory_document_id,
      sectionName: item.section_name,
      operationType: item.operation_type,
      targetItemHash: item.target_item_hash || '',
      proposedText: clip(item.proposed_text || '', 1200),
      rationale: clip(item.rationale || '', 1200),
      baselineVersionId: document?.currentVersionId || '',
      baselineContentHash: document?.contentHash || '',
    };
  });
}

function rejectedResult(input) { return { status: 'rejected', ...input }; }
function replayPrompt(item, skill, memory) { return `Use only the supplied Skill and Memory to answer the evaluation. Your response is the actual final Agent output: obey every strict, minimal, JSON, CSV, or other format requirement in the Input, and never explain the evaluation or mention Skill, Memory, tests, hidden checks, or an expected answer.\nSkill:\n${clip(skill, 14000)}\nMemory:\n${clip(memory, 7000)}\nInput: ${item.input}`; }
function compileSkill(base, overlay) { const clean = String(overlay || '').trim(); return clean ? `${String(base || '').trimEnd()}\n\n<!-- JANUS PERSONAL OVERLAY START -->\n${clean}\n<!-- JANUS PERSONAL OVERLAY END -->\n` : String(base || ''); }
function clip(value, limit) { const text = String(value || ''); return text.length > limit ? `${text.slice(0, limit)}…` : text; }
function parseJsonObject(raw, message) { let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''); const match = text.match(/\{[\s\S]*\}/); if (match) text = match[0]; try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {} throw new Error(message); }

function parseStructuredEvidence(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function stripStructuredEvidenceInternalReferences(value) {
  if (Array.isArray(value)) return value.map(stripStructuredEvidenceInternalReferences).filter((item) => item !== undefined);
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (STRUCTURED_EVIDENCE_INTERNAL_REFERENCE_KEYS.has(key)) return [];
    const next = stripStructuredEvidenceInternalReferences(item);
    return next === undefined ? [] : [[key, next]];
  }));
}

export function hashEvolutionSnapshot(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function evolutionPrivacyFindings(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.match(EVOLUTION_PRIVATE_PATTERN) || [];
}

export function evolutionEvidencePrivacyFindings(value, { sourceKind = '' } = {}) {
  if (!STRUCTURED_EVIDENCE_PRIVACY_SOURCES.has(String(sourceKind || ''))) return evolutionPrivacyFindings(value);
  const parsed = parseStructuredEvidence(value);
  if (!parsed) return evolutionPrivacyFindings(value);
  return evolutionPrivacyFindings(stripStructuredEvidenceInternalReferences(parsed));
}

export function evolutionEvidencePrivacyPolicyUpgradeable(sourceKind = '') {
  return STRUCTURED_EVIDENCE_PRIVACY_SOURCES.has(String(sourceKind || ''));
}

export function redactEvolutionPrivateText(value = '') {
  return String(value || '')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|私钥|密码|密钥)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi, '$1[redacted-secret]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted-phone]')
    .replace(/\b(?:user|uagent|session|task|msg|memdoc|memdocver)_[0-9a-z-]{8,}\b/gi, '[redacted-id]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted-id]')
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users|tmp|var|private|mnt)\/)[^\s"'`]+/g, '[redacted-path]')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-secret]');
}

export function sanitizeEvolutionPayloadForStorage(value) {
  if (typeof value === 'string') return redactEvolutionPrivateText(value);
  if (Array.isArray(value)) return value.map(sanitizeEvolutionPayloadForStorage);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeEvolutionPayloadForStorage(item)]));
}
