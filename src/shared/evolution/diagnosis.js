const LAYERS = Object.freeze([
  'tool_runtime',
  'intent_alignment',
  'evidence_quality',
  'memory_governance',
  'artifact_contract',
  'skill_procedure',
]);

const FEATURES = [
  ['tool_runtime', 'runtime_or_tool_failure', 0.78, /\b(traceback|exception|error|failed|timeout|cancelled|退出码|报错|失败|超时)\b/i],
  ['intent_alignment', 'user_correction_or_intent_mismatch', 0.74, /(不对|不是|误解|没理解|重新|改成|应该是|你理解错|wrong|misunderstood)/i],
  ['evidence_quality', 'source_or_citation_risk', 0.82, /(?=.*(引用|citation|doi|arxiv|来源|source|paper|论文|文献))(?=.*(编造|不存在|fake|hallucinat|不真实|无来源))/is],
  ['memory_governance', 'memory_boundary_or_privacy', 0.76, /(不要(?:存|记)|不应(?:存|记)|memory\s+(?:boundary|privacy|leak|private)|记忆(?:边界|隐私|泄漏)|隐私|private|secret|密钥|未发表)/i],
  ['artifact_contract', 'artifact_delivery_gap', 0.8, /(?=.*(pptx|pdf|docx|main\.tex|references\.bib|artifact|文件|生成|导出))(?=.*(没有|缺少|打不开|无法打开|未生成|missing|not created))/is],
];

const RECOMMENDATIONS = {
  tool_runtime: 'Add runtime guardrails, explicit failure handling, and verification before delivery.',
  intent_alignment: 'Clarify intent, routing boundaries, and handoff rules before execution.',
  evidence_quality: 'Add source verification and evidence-quality checks.',
  memory_governance: 'Strengthen private-memory boundaries and reusable-memory rules.',
  artifact_contract: 'Verify required artifacts exist and satisfy their delivery contract.',
  skill_procedure: 'Add a narrow, reusable procedure grounded in repeated evidence.',
};

export function diagnoseEvolutionEvidence({ agentFamilyId = '', departmentId = '', evidence = [] } = {}) {
  const recent = evidence.slice(-60);
  const text = recent.map((item) => String(item.content || '')).join('\n').toLowerCase();
  const scores = Object.fromEntries(LAYERS.map((layer) => [layer, layer === 'skill_procedure' ? 0.55 : 0]));
  const failures = { skill_procedure: 'procedure_gap' };
  const signals = [];
  for (const [layer, failureType, score, pattern] of FEATURES) {
    if (!pattern.test(text)) continue;
    scores[layer] = Math.max(scores[layer], score);
    failures[layer] = failureType;
    signals.push(`${failureType} evidence detected`);
  }
  const primaryLayer = LAYERS.reduce((best, layer) => scores[layer] > scores[best] ? layer : best, 'skill_procedure');
  return {
    agent_family_id: agentFamilyId,
    department_id: departmentId,
    primary_layer: primaryLayer,
    failure_type: failures[primaryLayer] || 'procedure_gap',
    confidence: Number(scores[primaryLayer].toFixed(2)),
    evidence_count: evidence.length,
    signals: signals.slice(0, 8),
    recommendation: RECOMMENDATIONS[primaryLayer],
    layer_scores: scores,
    classifier: 'shared_deterministic_v1',
  };
}
