export const DEFAULT_GATE_CALIBRATION = {
  minScore: 0.72,
  validationErrorPenalty: 0.12,
  validationErrorCap: 0.55,
  diagnosticAlignmentPenalty: 0.22,
  thinRisksPenalty: 0.08,
  thinEvalPenalty: 0.06,
  minRisksChars: 12,
  minEvalChars: 12,
};

const REQUIRED_AGENT_SECTIONS = [
  'Summary',
  'Proposed memory replacement',
  'Proposed memory patch',
  'Proposed skill patch',
  'Eval cases',
  'HR notes',
  'Risks',
];

export function extractMarkdownSection(markdown, heading) {
  const marker = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'im');
  const match = marker.exec(markdown || '');
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = /\n##\s+/m.exec(rest);
  return rest.slice(0, next ? next.index : rest.length).trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateAgentProposal(agent, proposal) {
  const errors = [];
  for (const section of REQUIRED_AGENT_SECTIONS) {
    if (!extractMarkdownSection(proposal, section)) errors.push(`Missing section: ${section}`);
  }
  const replacement = extractMarkdownSection(proposal, 'Proposed memory replacement');
  if (replacement && !/^no-op$/i.test(replacement.trim())) {
    const required = [
      `# Agent Memory: ${agent.id}`,
      '## Stable Learnings',
      '## Reusable Preferences',
      '## Failure Modes',
      '## Workflow Notes',
      '## Topic Files',
      '## Do Not Store',
    ];
    for (const item of required) {
      if (!replacement.includes(item)) errors.push(`Memory replacement missing heading: ${item}`);
    }
  }
  const skillPatch = extractMarkdownSection(proposal, 'Proposed skill patch');
  const memoryPatch = extractMarkdownSection(proposal, 'Proposed memory patch');
  if (/^#\s+/m.test(skillPatch)) errors.push('Skill patch must target existing sections, not replace the full skill document.');
  if (/Evolution|Lessons|学习记录/i.test(skillPatch) && !/Add to \*\*/.test(skillPatch)) {
    errors.push('Skill patch appears to create a generic append-only section.');
  }
  const proposedWrites = [replacement, memoryPatch, skillPatch].join('\n');
  if (/(?:\$CODEX_HOME|[\\/]agents[\\/].*\.toml|[\\/]memories[\\/]|developer_instructions|AGENTS\.md|config\.toml)/i.test(proposedWrites)) {
    errors.push('Proposal attempts to modify a generated or authoritative Codex harness surface. Evolution may change only the source SKILL.md and governed Agent MEMORY.md.');
  }
  if (/(password|token|api[_ -]?key|密钥|未发表数据|用户身份)/i.test(proposal)) {
    errors.push('Proposal contains potential private or secret material.');
  }
  return errors;
}

export function proposalAlignsWithDiagnosis(proposal, diagnostic) {
  const text = String(proposal || '').toLowerCase();
  const layer = diagnostic?.primary_layer || 'skill_procedure';
  const terms = {
    tool_runtime: ['runtime', 'tool', 'error', 'timeout', 'artifact check', '失败', '超时', '工具'],
    intent_alignment: ['clarify', 'handoff', 'route', 'intent', 'ask', '澄清', '交接', '路由'],
    evidence_quality: ['source', 'citation', 'verify', 'evidence', '引用', '来源', '文献', '核验'],
    memory_governance: ['memory', 'privacy', 'do not store', 'typed memory', '记忆', '隐私', '不要存'],
    artifact_contract: ['artifact', 'file', 'export', 'pptx', 'pdf', 'docx', '生成', '导出', '文件'],
    skill_procedure: ['workflow', 'procedure', 'checklist', 'skill', '流程', '步骤', '规范'],
  }[layer] || [];
  return terms.some((term) => text.includes(term));
}

export function scoreEvolutionGate({ proposal, diagnostic, validationErrors = [], calibration = DEFAULT_GATE_CALIBRATION }) {
  let score = 1;
  const reasons = [];
  if (validationErrors.length) {
    score -= Math.min(
      calibration.validationErrorCap,
      calibration.validationErrorPenalty * validationErrors.length,
    );
    reasons.push(...validationErrors);
  }
  const aligned = proposalAlignsWithDiagnosis(proposal, diagnostic);
  if (!aligned) {
    score -= calibration.diagnosticAlignmentPenalty;
    reasons.push(`Proposal does not align with diagnosis layer ${diagnostic?.primary_layer || 'unknown'}.`);
  }
  const risks = extractMarkdownSection(proposal, 'Risks');
  if (risks.length < calibration.minRisksChars) {
    score -= calibration.thinRisksPenalty;
    reasons.push('Risks section is too thin.');
  }
  const evalCases = extractMarkdownSection(proposal, 'Eval cases');
  if (evalCases.length < calibration.minEvalChars) {
    score -= calibration.thinEvalPenalty;
    reasons.push('Eval cases section is too thin.');
  }
  score = Math.max(0, Number(score.toFixed(3)));
  const passed = score >= calibration.minScore && validationErrors.length === 0 && aligned;
  return {
    status: passed ? 'passed' : 'failed',
    score,
    min_score: calibration.minScore,
    reasons,
    diagnostic_alignment: aligned,
    validation_errors: validationErrors,
  };
}
