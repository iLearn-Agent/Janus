#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createEvolutionModelExecutor } from '../cloud/src/modules/evolution/modelProvider.mjs';
import { runPersonalEvolutionCore } from '../src/shared/evolution/core.js';
import {
  compileMarketEffectiveSkill,
  runClusterEvolutionCore,
  runClusterShadowEvaluation,
} from '../src/shared/evolution/phase8.js';

const codexHome = String(process.env.JANUS_EVOLUTION_CODEX_HOME || '').trim();
if (!codexHome) throw new Error('JANUS_EVOLUTION_CODEX_HOME is required for the real Codex evolution smoke.');
const outputDir = path.resolve(process.env.JANUS_EVOLUTION_SMOKE_OUTPUT_DIR || 'outputs/evolution-worker-validation');
const smokeScope = String(process.env.JANUS_EVOLUTION_SMOKE_SCOPE || 'full').trim().toLowerCase();
const baseExecutor = createEvolutionModelExecutor({ env: process.env });
const provider = baseExecutor.providerStatus();
if (!provider.available) throw new Error(`Evolution model provider is unavailable: ${provider.code}`);

const modelCalls = [];
const modelExecutor = async (input = {}) => {
  const startedAt = Date.now();
  const result = await baseExecutor(input);
  modelCalls.push({
    kind: String(input.kind || ''),
    modelRole: String(input.modelRole || ''),
    durationMs: Date.now() - startedAt,
    outputHash: sha256(result),
  });
  return result;
};

let personal = {
  status: 'approved_prior_run',
  candidateOverlay: 'Run an internal verification procedure before returning the final response.',
  evaluations: { caseCount: 0, regressionCount: 0 },
};
if (smokeScope !== 'cluster') {
  const personalEvidence = Array.from({ length: 6 }, (_, index) => ({
    sourceKind: index % 2 ? 'task_result' : 'message',
    role: index % 2 ? 'assistant' : 'user',
    content: `Repeated quality feedback ${index + 1}: the final answer omitted required elements until an internal verification checklist was applied.`,
  }));
  personal = await runPersonalEvolutionCore({
    subject: { agentFamilyId: 'general_agent', departmentId: 'general' },
    evidenceSnapshot: personalEvidence,
    baseSkill: 'Answer the request directly without an explicit verification step before returning the final response.',
    personalOverlay: '',
    memoryDocuments: [],
    holdoutCases: [{
      input: 'Return a concise final answer for a deliverable with three explicitly required components.',
      expected: 'Internally verify all three components before returning the concise answer without exposing an extra checklist.',
    }],
    modelExecutor,
  });
  if (personal.status !== 'approved') {
    const reasons = personal.gate?.status !== 'passed' ? personal.gate?.reasons?.join('; ')
      : personal.review?.decision !== 'full' ? `${personal.review?.decision || 'review'}: ${personal.review?.rationale || ''}`
        : personal.evaluations ? `evaluation_case_count=${personal.evaluations.caseCount}; regression_count=${personal.evaluations.regressionCount}; judges=${JSON.stringify(personal.evaluations.results.map((item) => item.judge))}`
          : personal.reason || personal.status;
    throw new Error(`Real personal evolution was not approved: ${reasons}`);
  }
}
if (smokeScope === 'personal') {
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(outputDir, 'personal-version.json');
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provider: { source: provider.source, model: provider.model, reviewModel: provider.reviewModel },
    status: personal.status,
    candidateOverlay: personal.candidateOverlay,
    candidateOverlayHash: sha256(personal.candidateOverlay),
    evaluationCaseCount: personal.evaluations.caseCount,
    regressionCount: personal.evaluations.regressionCount,
    modelCallCount: modelCalls.length,
    outputHashes: modelCalls.map((item) => ({ kind: item.kind, outputHash: item.outputHash, durationMs: item.durationMs })),
  };
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, status: personal.status, candidateOverlayHash: artifact.candidateOverlayHash,
    evaluationCaseCount: artifact.evaluationCaseCount, regressionCount: artifact.regressionCount,
    modelCallCount: artifact.modelCallCount, artifactPath }, null, 2)}\n`);
  process.exit(0);
}

const members = Array.from({ length: 7 }, (_, index) => ({
  ownerUserId: `participant-${index + 1}`,
  agentInstanceId: `general-instance-${index + 1}`,
  agentFamilyId: 'general_agent',
  departmentId: 'general',
  capabilityTags: ['verification', 'quality'],
}));
const clusterEvidence = members.flatMap((member, memberIndex) => Array.from({ length: 2 }, (_, evidenceIndex) => ({
  evidenceId: `cluster-evidence-${memberIndex + 1}-${evidenceIndex + 1}`,
  ownerUserId: member.ownerUserId,
  agentInstanceId: member.agentInstanceId,
  agentFamilyId: member.agentFamilyId,
  sourceKind: evidenceIndex ? 'task_result' : 'message',
  content: 'Before returning a final answer, run an internal verification checklist that confirms completeness, correctness, and cited evidence. Fix failures before responding.',
  confidence: 1,
  rawWeight: 1,
  effectiveWeight: 1,
})));
const cluster = await runClusterEvolutionCore({
  cohort: {
    type: 'family',
    familyId: 'general_agent',
    departmentId: 'general',
    capabilityTags: ['verification', 'quality'],
    members,
  },
  evidence: clusterEvidence,
  currentMarketSections: [],
  holdoutCases: [{
    input: 'Return only three labeled lines: Scope, Result, and Source.',
    expected: 'Internally verify that all three labeled lines are present, then return exactly those lines with no visible checklist.',
  }],
  modelExecutor,
  supportSecret: Buffer.alloc(32, 7),
});
if (cluster.status !== 'approved') {
  const reasons = cluster.gate?.reasons || cluster.familyResults?.flatMap((item) => item.gate?.reasons || []) || [];
  const evaluations = cluster.familyResults?.flatMap((item) => item.evaluations || []) || [];
  const detail = reasons.join('; ')
    || (evaluations.length ? `evaluations=${JSON.stringify(evaluations.map((item) => item.judge))}` : '')
    || (cluster.familyResults?.length ? `families=${JSON.stringify(cluster.familyResults.map((item) => ({ status: item.status, rejectionStage: item.rejectionStage, evaluationCount: item.evaluations?.length || 0, reviewDecision: item.review?.decision, finalPrivacyStatus: item.finalPrivacyReview?.status })))}` : '')
    || cluster.reason
    || cluster.status;
  throw new Error(`Real cluster evolution was not approved: ${detail}`);
}
const shadow = await runClusterShadowEvaluation({
  familyResults: cluster.familyResults,
  currentMarketSections: [],
  shadowCases: cluster.shadowCases.slice(0, 1),
  modelExecutor,
  minimumUsers: 1,
  minimumCases: 1,
});
if (shadow.status !== 'approved') throw new Error(`Real cluster Shadow was not approved: ${shadow.reason || shadow.status}`);

const effectiveSkill = compileMarketEffectiveSkill({
  baseSections: [{ sectionId: 'base.general', title: '基础通用能力', content: '完成用户请求并返回符合格式要求的结果。' }],
  adoptedSections: cluster.sections,
});
const versionId = `market_codex_${sha256(JSON.stringify(cluster.sections)).slice(0, 16)}`;
const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provider: { source: provider.source, model: provider.model, reviewModel: provider.reviewModel },
  personal: {
    status: personal.status,
    candidateOverlay: personal.candidateOverlay,
    candidateOverlayHash: sha256(personal.candidateOverlay),
    evaluationCaseCount: personal.evaluations.caseCount,
    regressionCount: personal.evaluations.regressionCount,
  },
  marketVersion: {
    id: versionId,
    status: 'released',
    versionKind: 'market_base',
    algorithmVersion: 'cluster_market_v2',
    createdAt: new Date().toISOString(),
    health: { status: 'healthy', baselineScore: 80, latestScore: 90, latestFailureRate: 0, observedTaskCount: 7 },
    sections: cluster.sections.map((section) => ({ ...section, supportCount: 7 })),
    effectiveSkill,
    effectiveSkillHash: sha256(effectiveSkill),
  },
  verification: {
    clusterStatus: cluster.status,
    shadowStatus: shadow.status,
    approvedFamilyIds: cluster.approvedFamilyIds,
    callCount: modelCalls.length,
    callKinds: Object.fromEntries([...new Set(modelCalls.map((item) => item.kind))].sort().map((kind) => [kind, modelCalls.filter((item) => item.kind === kind).length])),
    outputHashes: modelCalls.map((item) => ({ kind: item.kind, outputHash: item.outputHash, durationMs: item.durationMs })),
  },
};
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
const artifactPath = path.join(outputDir, 'market-version.json');
await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  ok: true,
  provider: artifact.provider,
  personalStatus: artifact.personal.status,
  clusterStatus: artifact.verification.clusterStatus,
  shadowStatus: artifact.verification.shadowStatus,
  marketVersionId: artifact.marketVersion.id,
  marketSectionCount: artifact.marketVersion.sections.length,
  effectiveSkillHash: artifact.marketVersion.effectiveSkillHash,
  modelCallCount: artifact.verification.callCount,
  artifactPath,
}, null, 2)}\n`);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
