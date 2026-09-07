import { runCodexExec } from './codex.js';
import { clipText, safeJsonParse } from './utils.js';

export const LAYERS = [
  'tool_runtime',
  'intent_alignment',
  'evidence_quality',
  'memory_governance',
  'artifact_contract',
  'skill_procedure',
];

const FEATURES = [
  {
    layer: 'tool_runtime',
    failureType: 'runtime_or_tool_failure',
    score: 0.78,
    signal: 'runtime/error terms found',
    pattern: /\b(traceback|exception|error|failed|timeout|cancelled|退出码|报错|失败|超时)\b/i,
    target: 'all',
  },
  {
    layer: 'intent_alignment',
    failureType: 'user_correction_or_intent_mismatch',
    score: 0.74,
    signal: 'user correction terms found',
    pattern: /(不对|不是|误解|没理解|重新|改成|应该是|你理解错|wrong|misunderstood)/i,
    target: 'user',
  },
  {
    layer: 'evidence_quality',
    failureType: 'source_or_citation_risk',
    score: 0.82,
    signal: 'source-quality risk terms found',
    pattern: /(?=.*(引用|citation|doi|arxiv|来源|source|paper|论文|文献))(?=.*(编造|不存在|fake|hallucinat|不真实|无来源))/is,
    target: 'all',
  },
  {
    layer: 'memory_governance',
    failureType: 'memory_boundary_or_privacy',
    score: 0.76,
    signal: 'memory/privacy terms found',
    pattern: /(memory|记忆|记住|不要存|隐私|private|secret|密钥|未发表)/i,
    target: 'all',
  },
  {
    layer: 'artifact_contract',
    failureType: 'artifact_delivery_gap',
    score: 0.8,
    signal: 'artifact delivery terms found',
    pattern: /(?=.*(pptx|pdf|docx|main\.tex|references\.bib|artifact|文件|生成|导出))(?=.*(没有|缺少|打不开|无法打开|未生成|missing|not created))/is,
    target: 'all',
  },
];

const RECOMMENDATIONS = {
  tool_runtime: 'Prefer tool/runtime guardrails, artifact checks, and explicit failure handling before changing memory.',
  intent_alignment: 'Prefer skill clarification, routing boundaries, and handoff rules.',
  evidence_quality: 'Prefer citation/source verification rules and evidence QA checks.',
  memory_governance: 'Prefer typed memory/privacy rules and compact memory replacement.',
  artifact_contract: 'Prefer artifact contract checks and deliverable validation rules.',
  skill_procedure: 'Prefer narrow skill procedure or failure-mode guidance.',
};

function joinContent(evidence, role = '') {
  return evidence
    .filter((item) => !role || String(item.role || '').toLowerCase() === role)
    .map((item) => String(item.content || ''))
    .join('\n')
    .toLowerCase();
}

export function diagnosticTerms(text) {
  const tokens = String(text || '').toLowerCase().match(/[\w\u4e00-\u9fff]{2,24}/g) || [];
  const stop = new Set(['the', 'and', 'this', 'that', 'with', '一个', '这个', '那个', '需要', '帮我', '可以']);
  const result = [];
  for (const token of tokens) {
    if (stop.has(token) || result.includes(token)) continue;
    result.push(token);
    if (result.length >= 8) break;
  }
  return result;
}

export function diagnoseAgentEvidence({ agentId, departmentId, evidence }) {
  const recent = evidence.slice(-40);
  const allText = joinContent(recent);
  const userText = joinContent(recent, 'user');
  const assistantText = joinContent(recent, 'assistant');
  const layerScores = Object.fromEntries(LAYERS.map((layer) => [layer, 0]));
  layerScores.skill_procedure = 0.55;
  const failureTypes = { skill_procedure: 'procedure_gap' };
  const signals = [];
  const matchedFeatures = [];

  for (const feature of FEATURES) {
    const targetText = feature.target === 'user' ? userText : allText;
    if (feature.pattern.test(targetText)) {
      layerScores[feature.layer] = Math.max(layerScores[feature.layer], feature.score);
      failureTypes[feature.layer] = feature.failureType;
      signals.push(feature.signal);
      matchedFeatures.push({
        layer: feature.layer,
        score: feature.score,
        signal: feature.signal,
        target: feature.target,
      });
    }
  }

  if (
    departmentId === 'ppt_department' &&
    /(layout|排版|visual|视觉|speaker note|备注|research scout|证据包)/i.test(allText)
  ) {
    signals.push('multi-agent PPT workflow terms found');
    matchedFeatures.push({
      layer: 'artifact_contract',
      score: 0.04,
      signal: 'multi-agent PPT workflow terms found',
      target: 'all',
    });
    layerScores.artifact_contract = Math.max(layerScores.artifact_contract, 0.59);
  }

  if (!signals.length) signals.push('no explicit failure terms; treating as reusable procedure refinement');
  const primaryLayer = LAYERS.reduce((best, layer) => {
    const currentKey = [layerScores[layer], -LAYERS.indexOf(layer)];
    const bestKey = [layerScores[best], -LAYERS.indexOf(best)];
    return currentKey[0] > bestKey[0] || (currentKey[0] === bestKey[0] && currentKey[1] > bestKey[1])
      ? layer
      : best;
  }, LAYERS[0]);

  return {
    agent_id: agentId,
    department_id: departmentId,
    primary_layer: primaryLayer,
    failure_type: failureTypes[primaryLayer] || 'procedure_gap',
    confidence: Number(layerScores[primaryLayer].toFixed(2)),
    evidence_messages: evidence.length,
    signals: signals.slice(0, 8),
    recommendation: RECOMMENDATIONS[primaryLayer] || RECOMMENDATIONS.skill_procedure,
    sample_user_terms: diagnosticTerms(userText),
    sample_assistant_terms: diagnosticTerms(assistantText),
    layer_scores: Object.fromEntries(Object.entries(layerScores).map(([key, value]) => [key, Number(value.toFixed(2))])),
    matched_features: matchedFeatures.slice(0, 12),
    classifier: 'deterministic_lightweight_v1',
  };
}

export function buildLlmDiagnosisPrompt({ baseDiagnostic, evidence }) {
  const clipped = evidence.slice(-24).map((item) => ({
    role: item.role,
    created_at: item.created_at,
    content: clipText(item.content || '', 1200),
  }));
  return `You are a lightweight trajectory classifier for an auditable self-evolution system.

Backend deterministic diagnosis:
\`\`\`json
${JSON.stringify(baseDiagnostic, null, 2)}
\`\`\`

Recent visible evidence:
\`\`\`json
${JSON.stringify(clipped, null, 2)}
\`\`\`

Return one JSON object only:
{
  "primary_layer": "tool_runtime | intent_alignment | evidence_quality | memory_governance | artifact_contract | skill_procedure",
  "failure_type": "short_snake_case",
  "confidence": 0.0,
  "signals": ["short reusable signal"],
  "recommendation": "one sentence",
  "rationale": "brief evidence-grounded rationale"
}

Rules:
- Do not invent private facts.
- Prefer the backend diagnosis unless the evidence clearly supports another layer.
- Keep confidence between 0.50 and 0.95.
`;
}

export function parseLlmDiagnosis(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced) text = fenced[1];
  const parsed = safeJsonParse(text, null);
  if (!parsed || !LAYERS.includes(parsed.primary_layer)) return null;
  const confidence = Math.min(0.95, Math.max(0.5, Number(parsed.confidence || 0.5)));
  return {
    primary_layer: parsed.primary_layer,
    failure_type: String(parsed.failure_type || 'llm_refinement').slice(0, 80),
    confidence,
    signals: Array.isArray(parsed.signals) ? parsed.signals.map(String).slice(0, 8) : [],
    recommendation: String(parsed.recommendation || '').slice(0, 400),
    rationale: String(parsed.rationale || '').slice(0, 1000),
    classifier: 'hybrid_rule_llm_v1',
  };
}

export function mergeDiagnoses(base, llm) {
  if (!llm) return base;
  const merged = { ...base, llm_layer: llm.primary_layer, llm_confidence: llm.confidence, llm_rationale: llm.rationale };
  const sameLayer = llm.primary_layer === base.primary_layer;
  const canOverride = llm.confidence >= Math.max(0.78, Number(base.confidence || 0) + 0.08);
  if (sameLayer || canOverride) {
    merged.primary_layer = llm.primary_layer;
    merged.failure_type = llm.failure_type || base.failure_type;
    merged.confidence = Math.max(Number(base.confidence || 0), llm.confidence);
    merged.signals = [...new Set([...(base.signals || []), ...(llm.signals || [])])].slice(0, 8);
    merged.recommendation = llm.recommendation || base.recommendation;
  }
  merged.base_layer = base.primary_layer;
  merged.base_confidence = base.confidence;
  return merged;
}

export async function hybridDiagnoseAgentEvidence({ root, agent, evidence, llm = true, executionContext = null }) {
  const base = diagnoseAgentEvidence({
    agentId: agent.id,
    departmentId: agent.departmentId,
    evidence,
  });
  if (!llm) return base;
  try {
    const raw = await runCodexExec({
      prompt: buildLlmDiagnosisPrompt({ baseDiagnostic: base, evidence }),
      agentId: agent.id,
      role: 'diagnosis',
      root,
      sandbox: 'read-only',
      executionContext,
    });
    return mergeDiagnoses(base, parseLlmDiagnosis(raw));
  } catch (error) {
    return { ...base, llm_error: String(error.message || error).slice(0, 300) };
  }
}
