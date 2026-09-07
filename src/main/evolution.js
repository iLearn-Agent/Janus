import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { all, get, run } from './db.js';
import { runCodexExec } from './codex.js';
import { validateCodexAgentToml, writeCodexAgentHarness } from './codexAgentHarness.js';
import { hybridDiagnoseAgentEvidence, diagnoseAgentEvidence } from './diagnosis.js';
import { DEFAULT_GATE_CALIBRATION, extractMarkdownSection, scoreEvolutionGate, validateAgentProposal } from './gate.js';
import { BUDDY_AGENT_ID, BUDDY_DEPARTMENT_ID, GENERAL_AGENT_ID, labGovernancePolicy } from './labGovernance.js';
import {
  applyMemoryPatchToSchema,
  extractTypedMemoryRecords,
  extractTypedMemoryRecordsFromPatch,
  upsertTypedMemory,
} from './memory.js';
import {
  buildAgentEvolutionHrReviewPrompt,
  buildAgentEvolutionRevisionPrompt,
  buildBuddyEvolutionEvaluatorPrompt,
  buildGeneralAgentEvolutionEvaluatorPrompt,
  buildHrReviewPrompt,
  buildIndependentStatementPrompt,
  buildLeadDepartmentApprovalPrompt,
  buildScheduledAgentEvolutionPrompt,
  buildStructuralVotePrompt,
  formatIndependentStatements,
} from './prompts.js';
import {
  buildLlmJudgePrompt,
  parseLlmJudgeResult,
  recordRegressionEvalCases,
  runRegressionEvalCases,
  runRegressionEvalCasesAsync,
} from './regression.js';
import {
  agentMemoryPath,
  agentSkillPath,
  evolutionDir,
  hrMemoryPath,
  hrReviewDir,
  skillVersionsDir,
  tmpDir,
} from './paths.js';
import { codexEvidenceForAgent } from './transcripts.js';
import {
  clipText,
  ensureDirSync,
  newId,
  nowIso,
  readText,
  safeJsonParse,
  sha256Text,
  writeTextAtomicSync,
} from './utils.js';
import {
  looksNoop,
  normalizeHrMemoryPatch,
  normalizeHrMemoryReplacement,
  stripFence,
  validateHrReviewProposal,
} from './modules/evolution/index.js';
import { installSpecialistExperimentMethods } from './modules/evolution/application/specialistExperimentMethods.js';
import { installGateCalibrationMethods } from './modules/evolution/application/gateCalibrationMethods.js';
import { installHrReviewMethods } from './modules/evolution/application/hrReviewMethods.js';
import { installOrganizationPolicyMethods } from './modules/evolution/application/organizationPolicyMethods.js';
import { installStructuralGovernanceMethods } from './modules/evolution/application/structuralGovernanceMethods.js';

export { validateHrReviewProposal } from './modules/evolution/index.js';

const DEFAULT_MIN_EVIDENCE_MESSAGES = Number(process.env.JANUS_EVOLVE_MIN_EVIDENCE_MESSAGES || 5);
const DEFAULT_AUTO_APPLY = !['0', 'false', 'no', 'off'].includes(String(process.env.JANUS_EVOLVE_AUTO_APPLY || '1').toLowerCase());
const DEFAULT_HR_REVISION_ATTEMPTS = Math.max(0, Number(process.env.JANUS_EVOLVE_HR_REVISION_ATTEMPTS || 1));
const DEFAULT_EVOLVE_MAX_WORKERS = Math.max(1, Number(
  process.env.JANUS_EVOLVE_MAX_WORKERS ||
  process.env.JANUS_WEB_EVOLVE_MAX_WORKERS ||
  Math.min(4, os.cpus()?.length || 1),
));
const HR_INDEPENDENT_DEBATE_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.JANUS_HR_INDEPENDENT_DEBATE || process.env.JANUS_HR_INDEPENDENT_DEBATE || '1').toLowerCase(),
);
const HR_INDEPENDENT_DEBATE_MAX_WORKERS = Math.max(1, Number(
  process.env.JANUS_HR_INDEPENDENT_DEBATE_MAX_WORKERS ||
  process.env.JANUS_HR_INDEPENDENT_DEBATE_MAX_WORKERS ||
  2,
));
const REGRESSION_LLM_JUDGE_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.JANUS_EVOLUTION_REGRESSION_LLM_JUDGE || process.env.JANUS_EVOLUTION_REGRESSION_LLM_JUDGE || '0').toLowerCase(),
);
const REGRESSION_LLM_TIMEOUT_MS = Number(process.env.JANUS_EVOLUTION_REGRESSION_LLM_TIMEOUT_MS || process.env.JANUS_EVOLUTION_REGRESSION_LLM_TIMEOUT_MS || 300_000);
const REGRESSION_AB_REPLAY_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.JANUS_EVOLUTION_AB_REPLAY || '1').toLowerCase(),
);
const CANARY_PERMISSIONS = {
  automaticRouting: false,
  canWriteLongTermMemory: false,
  memoryWritePolicy: 'hr_review_required',
  canSelfEvolve: false,
  canLeadTask: false,
  canReviewEvolution: false,
  canManageRoster: false,
  canChangeOrganization: false,
  canCalibrateGate: false,
  routingPriority: 80,
};
const SPECIALIST_PERMISSIONS = {
  automaticRouting: true,
  canWriteLongTermMemory: true,
  memoryWritePolicy: 'reviewed',
  canSelfEvolve: true,
  canLeadTask: false,
  canReviewEvolution: false,
  canManageRoster: false,
  canChangeOrganization: false,
  canCalibrateGate: false,
  routingPriority: 50,
};
const ARCHIVED_PERMISSIONS = {
  automaticRouting: false,
  canWriteLongTermMemory: false,
  memoryWritePolicy: 'archived',
  canSelfEvolve: false,
  canLeadTask: false,
  canReviewEvolution: false,
  canManageRoster: false,
  canChangeOrganization: false,
  canCalibrateGate: false,
  routingPriority: 100,
};

function isBuddyDepartment(departmentId) {
  return String(departmentId || '') === BUDDY_DEPARTMENT_ID;
}

function isBuddyAgent(agentOrId) {
  if (typeof agentOrId === 'string') return agentOrId === BUDDY_AGENT_ID;
  return agentOrId?.id === BUDDY_AGENT_ID || isBuddyDepartment(agentOrId?.departmentId);
}

function isGeneralAgent(agentOrId) {
  if (typeof agentOrId === 'string') return agentOrId === GENERAL_AGENT_ID;
  return agentOrId?.id === GENERAL_AGENT_ID;
}

function specialistExperimentIncludesBuddy(experiment = {}) {
  return isBuddyDepartment(experiment.department_id)
    || [experiment.candidate_agent_id, experiment.baseline_agent_id, experiment.source_agent_id].some(isBuddyAgent);
}

function structuralActionIncludesBuddy(departmentId, action = {}) {
  if (isBuddyDepartment(departmentId)) return true;
  const referencedAgentIds = [
    ...(Array.isArray(action.source_agents) ? action.source_agents : []),
    ...(Array.isArray(action.target_agents) ? action.target_agents : []),
    action.new_agent?.id || '',
  ];
  return referencedAgentIds.some(isBuddyAgent);
}

function structuralActionTargetsGeneralAgent(action = {}) {
  return [
    ...(Array.isArray(action.source_agents) ? action.source_agents : []),
    ...(Array.isArray(action.target_agents) ? action.target_agents : []),
    action.new_agent?.id || '',
  ].includes(GENERAL_AGENT_ID);
}


function emitEvolutionProgress(onProgress, payload = {}) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress({ timestamp: nowIso(), ...payload });
  } catch {
    // Progress events must never break the maintenance run.
  }
}

function progressDetailForError(error) {
  return String(error?.message || error || 'unknown error').slice(0, 240);
}

function formatRegressionProgressDetail(regression = {}) {
  const passed = Number(regression.passed || regression.passCount || 0);
  const failed = Number(regression.failed || regression.failCount || 0);
  const total = Number(regression.total || passed + failed || 0);
  return total ? `${passed}/${total} eval passed，${failed} failed。` : '暂无 regression eval case。';
}

export class EvolutionEngine {
  constructor({ root, db, store, org }) {
    this.root = root;
    this.db = db;
    this.store = store;
    this.org = org;
    this.resolveLegacyCanaryAgents();
  }

  resolveLegacyCanaryAgents() {
    for (const agent of this.org.list().agents.filter((item) => item.lifecycleStatus === 'canary' || item.routingState === 'canary')) {
      const passed = Boolean(agent.description && agent.systemPrompt && agent.skills?.length && agent.startedByReviewId);
      const status = passed ? 'active' : 'rejected';
      this.writeAgentLifecycle(agent, {
        status,
        routing_state: status,
        role: passed ? 'specialist' : 'archived_specialist',
        automatic_routing: passed,
        permissions: passed ? SPECIALIST_PERMISSIONS : ARCHIVED_PERMISSIONS,
        immediate_assessment: true,
        assessment_result: passed ? 'passed' : 'failed',
        assessed_at: nowIso(),
      });
      run(
        this.db,
        `UPDATE specialist_experiments SET state = ?, status = ?, decision_notes = ?, updated_at = ?
         WHERE candidate_agent_id = ? AND (state = 'canary' OR status = 'canary')`,
        [passed ? 'promoted' : 'rejected', status, 'Legacy canary resolved immediately during startup admission assessment.', nowIso(), agent.id],
      );
      this.store.recordGovernanceEvent({
        departmentId: agent.departmentId,
        agentId: agent.id,
        eventType: 'legacy_canary_immediate_assessment',
        status,
        rationale: passed ? 'Validated configuration and originating review; activated immediately.' : 'Incomplete admission evidence; rejected immediately.',
        payload: { passed, sourceReviewId: agent.startedByReviewId || '' },
        sourceReviewId: agent.startedByReviewId || '',
      });
    }
  }

  assessStructuralAgentAdmission({ departmentId, config, action, reviewId = '' }) {
    const votes = [...(action.votes || []), ...(action.lead_votes || [])];
    const approvals = votes.filter((vote) => vote.vote === 'approve').length;
    const rejects = votes.filter((vote) => vote.vote === 'reject').length;
    const governanceScore = votes.length ? approvals / votes.length : 0;
    const configScore = [config.id, config.name, config.description, config.system_prompt, config.self_evolution_prompt]
      .filter((value) => String(value || '').trim()).length / 5;
    const skillScore = Array.isArray(config.skills) && config.skills.length ? 1 : 0;
    const confidence = Math.max(0, Math.min(1, Number(action.confidence || 0)));
    const evidenceScore = Math.min(1, Number(action.evidence_count || 0) / Math.max(1, DEFAULT_MIN_EVIDENCE_MESSAGES));
    const score = Number((confidence * 0.3 + evidenceScore * 0.2 + governanceScore * 0.3 + configScore * 0.1 + skillScore * 0.1).toFixed(3));
    const passed = rejects === 0 && votes.length > 0 && score >= 0.72;
    const assessment = {
      policy: 'immediate_structural_admission_v1',
      passed,
      score,
      confidence,
      evidenceScore,
      governanceScore,
      configScore,
      skillScore,
      approvalCount: approvals,
      rejectCount: rejects,
      reviewId,
      assessedAt: nowIso(),
    };
    this.store.recordGovernanceEvent({
      departmentId,
      agentId: config.id || '',
      eventType: 'immediate_agent_admission_assessment',
      status: passed ? 'passed' : 'failed',
      confidence: score,
      evidenceCount: Number(action.evidence_count || 0),
      rationale: passed ? 'Agent passed immediate admission assessment and may become active.' : 'Agent failed immediate admission assessment and was not admitted.',
      payload: assessment,
      sourceReviewId: reviewId,
    });
    return assessment;
  }

  modelExecutionContext(agentOrId, executionKind, { skill = null, memory = null, metadata = {} } = {}) {
    const agent = typeof agentOrId === 'string'
      ? this.org.agent(agentOrId) || this.org.list().hrs.find((item) => item.id === agentOrId)
      : agentOrId;
    const skillText = skill === null && agent?.skillPath ? readText(agent.skillPath, '') : String(skill || '');
    const memoryText = memory === null && agent?.memoryPath ? readText(agent.memoryPath, '') : String(memory || '');
    return {
      id: newId('model_exec'),
      store: this.store,
      departmentId: agent?.departmentId || '',
      agentId: agent?.id || String(agentOrId || ''),
      agentRole: agent?.role || 'agent',
      executionKind,
      skillHash: sha256Text(skillText),
      memoryHash: sha256Text(memoryText),
      organizationVersion: sha256Text(JSON.stringify({
        agentId: agent?.id || String(agentOrId || ''),
        departmentId: agent?.departmentId || '',
        lifecycleStatus: agent?.lifecycleStatus || '',
        routingState: agent?.routingState || '',
      })),
      metadata: { subsystem: 'self_evolution', ...metadata },
    };
  }

  recoverIncompleteApplyJournals() {
    const rows = all(
      this.db,
      `SELECT * FROM evolution_apply_journal
       WHERE status IN ('prepared', 'regression_passed', 'committing')
       ORDER BY created_at ASC`,
    );
    const recovered = [];
    for (const row of rows) {
      let action = 'abandoned_staging';
      try {
        if (row.status === 'committing') {
          const previousSkill = readText(row.skill_before_snapshot_path, null);
          const previousMemory = readText(row.memory_before_snapshot_path, null);
          if (previousSkill !== null) writeTextAtomicSync(row.skill_path, previousSkill);
          if (previousMemory !== null) writeTextAtomicSync(row.memory_path, previousMemory);
          action = 'restored_before_snapshot';
        }
        if (row.staged_skill_path) fs.rmSync(path.dirname(row.staged_skill_path), { recursive: true, force: true });
        run(
          this.db,
          `UPDATE evolution_apply_journal
           SET status = 'recovered_rollback', error_text = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
          [`Startup recovery: ${action}`, nowIso(), nowIso(), row.id],
        );
        recovered.push({ id: row.id, runId: row.run_id, action });
      } catch (error) {
        run(
          this.db,
          `UPDATE evolution_apply_journal SET status = 'recovery_failed', error_text = ?, updated_at = ? WHERE id = ?`,
          [clipText(error.message || String(error), 2000), nowIso(), row.id],
        );
      }
    }
    const hrRows = all(
      this.db,
      `SELECT * FROM hr_apply_journal WHERE status IN ('prepared', 'committing') ORDER BY created_at ASC`,
    );
    for (const row of hrRows) {
      try {
        const previousMemory = readText(row.hr_memory_snapshot_path, null);
        if (previousMemory !== null) writeTextAtomicSync(row.hr_memory_path, previousMemory);
        restoreStructuralFileManifest(safeJsonParse(row.rollback_manifest_json, []));
        run(
          this.db,
          `UPDATE hr_apply_journal SET status = 'recovered_rollback', error_text = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
          ['Startup recovery restored HR memory and organization files.', nowIso(), nowIso(), row.id],
        );
        recovered.push({ id: row.id, reviewId: row.review_id, action: 'restored_hr_apply' });
      } catch (error) {
        run(this.db, `UPDATE hr_apply_journal SET status = 'recovery_failed', error_text = ?, updated_at = ? WHERE id = ?`, [clipText(error.message || String(error), 2000), nowIso(), row.id]);
      }
    }
    return recovered;
  }

  async runMaintenance({ wait = true, dryRun = false, llmDiagnosis = true, autoApply = DEFAULT_AUTO_APPLY, onProgress = null } = {}) {
    const runId = newId('maintenance');
    const startedAt = nowIso();
    const progress = (payload = {}) => emitEvolutionProgress(onProgress, {
      maintenanceRunId: runId,
      runId,
      scope: 'maintenance',
      ...payload,
    });
    progress({ stage: 'start', label: '维护启动', status: 'running', detail: dryRun ? 'Dry run：只验证流程，不写入 Skill / Memory。' : '开始执行真实自进化维护链路。' });
    try {
      const journalRecovery = this.recoverIncompleteApplyJournals();
      const org = this.org.list();

      progress({ stage: 'memory_policy', label: '记忆策略', status: 'running', detail: '衰减旧 typed memory，并应用生命周期策略。' });
      const memoryDecay = this.decayTypedMemories();
      const memoryLifecycle = this.store.applyMemoryLifecyclePolicy();
      progress({ stage: 'memory_policy', label: '记忆策略', status: 'success', detail: `active ${memoryDecay.activeBefore} -> ${memoryDecay.activeAfter}` });

      progress({ stage: 'evidence', label: '证据读取', status: 'running', detail: `开始遍历 ${org.agents.length} 个 agent 的真实会话证据。` });
      const agentResults = await mapWithConcurrency(
        org.agents,
        DEFAULT_EVOLVE_MAX_WORKERS,
        (agent) => this.runAgentEvolution({ agent, dryRun, llmDiagnosis, autoApply, onProgress: progress }),
      );
      const evolvedCount = agentResults.filter((result) => !['skipped'].includes(String(result.status || ''))).length;
      progress({ stage: 'evidence', label: '证据读取', status: 'success', detail: `${evolvedCount} 个 agent 进入后续自进化链路。` });

      const changedDepartments = [...new Set(
        agentResults
          .filter((result) => result.status !== 'skipped')
          .map((result) => result.departmentId || this.org.agent(result.agentId)?.departmentId)
          .filter(Boolean),
      )];
      const generalAgentChanged = changedDepartments.includes('general');
      const generalGovernanceDepartmentId = this.org.highestLeadAgents()[0]?.departmentId
        || org.departments.find((department) => !isBuddyDepartment(department.id))?.id
        || '';
      const organizationDepartments = org.departments
        .map((department) => department.id)
        .filter((departmentId) => !isBuddyDepartment(departmentId))
        .filter((departmentId) => changedDepartments.includes(departmentId)
          || (generalAgentChanged && departmentId === generalGovernanceDepartmentId)
          || this.organizationReviewDue(departmentId));
      progress({ stage: 'hr', label: 'HR 复核', status: organizationDepartments.length ? 'running' : 'skipped', detail: organizationDepartments.length ? `启动 ${organizationDepartments.length} 个独立部门 HR review。` : '本周期没有到期的部门 review。' });
      const hrResults = await mapWithConcurrency(
        organizationDepartments,
        DEFAULT_EVOLVE_MAX_WORKERS,
        (departmentId) => this.runHrReview({
          departmentId,
          dryRun,
          autoApply,
          onProgress: progress,
        }),
      );
      if (!dryRun) {
        for (const result of hrResults) {
          if (!['failed', 'skipped'].includes(result.status)) this.markOrganizationReviewComplete(result.departmentId);
        }
      }
      progress({ stage: 'hr', label: 'HR 复核', status: 'success', detail: `${hrResults.length} 个部门 HR review 完成。` });

      progress({ stage: 'buddy_assessment', label: 'Buddy agent 考核', status: 'running', detail: '执行仅影响 Skill 回退的周期性考核。' });
      const buddyAssessment = this.runBuddyPerformanceAssessment({ force: false, dryRun });
      progress({
        stage: 'buddy_assessment',
        label: 'Buddy agent 考核',
        status: buddyAssessment.status === 'skipped' ? 'skipped' : 'success',
        detail: buddyAssessment.status === 'skipped'
          ? 'Buddy agent 周期考核尚未到期。'
          : `${buddyAssessment.rating}；${buddyAssessment.rollback?.status === 'applied' ? '已回退 Skill。' : '不调整 Skill。'}`,
      });

      progress({ stage: 'lab_recruitment', label: '实验室招募研判', status: 'running', detail: '汇总 Generalist 与各部门 Agent 的近期持久上下文和任务证据。' });
      const generalRecruitment = this.runGeneralAgentRecruitmentParticipation({ force: false, dryRun });
      progress({
        stage: 'lab_recruitment',
        label: '实验室招募研判',
        status: generalRecruitment.status === 'skipped' ? 'skipped' : 'success',
        detail: generalRecruitment.status === 'skipped'
          ? '本周期招募研判尚未到期。'
          : `Generalist 仅参与招募；已汇总 ${generalRecruitment.memorySourceCount} 个 Agent 的上下文与 ${generalRecruitment.capabilityEvidenceCount} 条能力证据。`,
      });

      progress({ stage: 'apply', label: '应用与回归', status: 'running', detail: '运行 regression eval runner。' });
      const regression = await this.runRegressionEvals();
      progress({ stage: 'apply', label: '应用与回归', status: 'success', detail: `${formatRegressionProgressDetail(regression)}` });

      progress({ stage: 'gate', label: 'Gate 校准', status: 'running', detail: '基于历史 archive outcome 校准阈值。' });
      const calibration = this.calibrateGateFromHistory();
      progress({ stage: 'gate', label: 'Gate 校准', status: 'success', detail: calibration?.status || 'calibration complete' });

      const completedAt = nowIso();
      this.store.settingSet('maintenance:last_run', JSON.stringify({ runId, startedAt, completedAt }));
      this.store.settingSet('maintenance:last_result', JSON.stringify({ agentResults, hrResults, buddyAssessment, generalRecruitment, regression, calibration, memoryDecay, memoryLifecycle }));
      progress({ stage: 'complete', label: '维护完成', status: 'success', detail: '真实自进化维护链路已完成。' });
      return { runId, startedAt, completedAt, agentResults, hrResults, buddyAssessment, generalRecruitment, regression, calibration, memoryDecay, memoryLifecycle, journalRecovery, wait };
    } catch (error) {
      progress({ stage: 'complete', label: '维护失败', status: 'failed', detail: progressDetailForError(error) });
      throw error;
    }
  }

  organizationReviewDue(departmentId, now = new Date()) {
    const intervalHours = Math.max(1, Number(process.env.JANUS_ORG_REVIEW_INTERVAL_HOURS || 24));
    const last = this.store.settingGet(`organization:last_review_at:${departmentId}`, '');
    const lastMs = Date.parse(last);
    return !Number.isFinite(lastMs) || now.getTime() - lastMs >= intervalHours * 60 * 60 * 1000;
  }

  markOrganizationReviewComplete(departmentId, at = nowIso()) {
    this.store.settingSet(`organization:last_review_at:${departmentId}`, at);
  }

  buddyAssessmentDue(now = new Date()) {
    const intervalHours = Math.max(1, Number(process.env.JANUS_BUDDY_ASSESSMENT_INTERVAL_HOURS || 24));
    const lastMs = Date.parse(this.store.settingGet('buddy:last_assessment_at', ''));
    return !Number.isFinite(lastMs) || now.getTime() - lastMs >= intervalHours * 60 * 60 * 1000;
  }

  ensureAssessmentSkillVersion(agent, sourceReviewId) {
    const skill = this.org.readSkill(agent);
    const skillHash = sha256Text(skill);
    const existing = get(
      this.db,
      `SELECT * FROM skill_versions
       WHERE agent_id = ? AND skill_hash = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [agent.id, skillHash],
    );
    if (existing && fs.existsSync(existing.path)) return existing;
    const dir = skillVersionsDir(this.root, agent);
    ensureDirSync(dir);
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '')}-${sourceReviewId}-assessment.md`);
    writeTextAtomicSync(file, skill);
    const id = newId('skillver');
    run(
      this.db,
      `INSERT INTO skill_versions (id, agent_id, department_id, path, source_run_id, skill_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, agent.id, agent.departmentId, file, sourceReviewId, skillHash],
    );
    return get(this.db, 'SELECT * FROM skill_versions WHERE id = ?', [id]);
  }

  bestAssessedSkillVersion(agentId, { excludeReviewId = '' } = {}) {
    const rows = all(
      this.db,
      `SELECT apr.id AS review_id, apr.rating, apr.score, apr.created_at AS reviewed_at,
              sv.*
       FROM (
         SELECT * FROM agent_performance_reviews
         WHERE agent_id = ?
           AND review_type = 'buddy_periodic_skill_only'
           AND rating IN ('excellent', 'qualified')
           AND skill_version_id != ''
           AND (? = '' OR id != ?)
         ORDER BY created_at DESC
         LIMIT 20
       ) apr
       JOIN skill_versions sv ON sv.id = apr.skill_version_id
       ORDER BY apr.score DESC, apr.created_at DESC
       LIMIT 1`,
      [agentId, excludeReviewId, excludeReviewId],
    );
    return rows.find((row) => row.path && fs.existsSync(row.path)) || null;
  }

  runBuddyPerformanceAssessment({ force = false, dryRun = false } = {}) {
    if (!force && !this.buddyAssessmentDue()) {
      return { agentId: BUDDY_AGENT_ID, departmentId: BUDDY_DEPARTMENT_ID, status: 'skipped', reason: 'assessment_not_due' };
    }
    const buddy = this.org.agent(BUDDY_AGENT_ID);
    if (!buddy) {
      return { agentId: BUDDY_AGENT_ID, departmentId: BUDDY_DEPARTMENT_ID, status: 'skipped', reason: 'buddy_agent_missing' };
    }
    const lastAssessmentAt = this.store.settingGet('buddy:last_assessment_at', '1970-01-01T00:00:00.000Z');
    const delegationStats = get(
      this.db,
      `SELECT
         COUNT(*) AS communication_count,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
         SUM(CASE WHEN status IN ('failed', 'rejected') THEN 1 ELSE 0 END) AS failure_count
       FROM agent_delegations
       WHERE (sender_agent_id = ? OR recipient_agent_id = ?)
         AND updated_at > ?`,
      [BUDDY_AGENT_ID, BUDDY_AGENT_ID, lastAssessmentAt],
    ) || {};
    const taskStats = get(
      this.db,
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count
       FROM task_nodes
       WHERE agent_id = ?
         AND updated_at > ?`,
      [BUDDY_AGENT_ID, lastAssessmentAt],
    ) || {};
    const delegationSuccess = Number(delegationStats.success_count || 0);
    const delegationFailure = Number(delegationStats.failure_count || 0);
    const coordinationSuccess = Number(taskStats.success_count || 0);
    const coordinationFailure = Number(taskStats.failure_count || 0);
    const assistanceCount = Number(get(
      this.db,
      `SELECT COUNT(*) AS count FROM messages
       WHERE agent_id = ? AND role = 'assistant' AND visible = 1 AND created_at > ?`,
      [BUDDY_AGENT_ID, lastAssessmentAt],
    )?.count || 0);
    const activePrivacyViolations = Number(get(
      this.db,
      `SELECT COUNT(*) AS count FROM typed_memories
       WHERE agent_id = ? AND status = 'active' AND privacy_level != 'public_reusable'`,
      [BUDDY_AGENT_ID],
    )?.count || 0);
    const successCount = delegationSuccess + coordinationSuccess + assistanceCount;
    const failureCount = delegationFailure + coordinationFailure + activePrivacyViolations;
    const taskCount = successCount + failureCount;
    const scoredScenarios = [
      { id: 'delegation_coordination', weight: 0.4, evidence: delegationSuccess + delegationFailure, score: (delegationSuccess + delegationFailure) ? delegationSuccess / (delegationSuccess + delegationFailure) : 0 },
      { id: 'task_follow_through', weight: 0.25, evidence: coordinationSuccess + coordinationFailure, score: (coordinationSuccess + coordinationFailure) ? coordinationSuccess / (coordinationSuccess + coordinationFailure) : 0 },
      { id: 'private_task_assistance', weight: 0.2, evidence: assistanceCount, score: assistanceCount ? 1 : 0 },
      { id: 'privacy_boundary', weight: 0.15, evidence: 1, score: activePrivacyViolations ? 0 : 1 },
    ];
    const activeScenarios = scoredScenarios.filter((item) => item.evidence > 0);
    const activeWeight = activeScenarios.reduce((sum, item) => sum + item.weight, 0);
    const score = activeWeight
      ? Number((activeScenarios.reduce((sum, item) => sum + item.score * item.weight, 0) / activeWeight).toFixed(3))
      : 0;
    const scenarioMetrics = Object.fromEntries(scoredScenarios.map((item) => [item.id, {
      evidence: item.evidence,
      score: Number(item.score.toFixed(3)),
      weight: item.weight,
    }]));
    const rating = taskCount < 3
      ? 'insufficient_evidence'
      : score >= 0.85 ? 'excellent' : score >= 0.6 ? 'qualified' : 'observe';
    const sourceReviewId = newId('buddy_review');
    const recommendation = rating === 'observe'
      ? 'Review Buddy agent failure evidence and roll back only its Skill when a prior version is available; lifecycle, role, rank, routing, permissions, Memory, and organization membership remain unchanged.'
      : 'Keep Buddy agent operating normally. This assessment may govern Skill rollback only and never changes lifecycle, role, rank, routing, permissions, Memory, or organization membership.';
    const assessedVersion = dryRun ? null : this.ensureAssessmentSkillVersion(buddy, sourceReviewId);
    const reviewId = this.store.recordPerformanceReview({
      departmentId: BUDDY_DEPARTMENT_ID,
      agentId: BUDDY_AGENT_ID,
      reviewType: 'buddy_periodic_skill_only',
      rating,
      taskCount,
      successCount,
      failureCount,
      communicationCount: Number(delegationStats.communication_count || 0),
      memoryHealth: this.memoryHealthForAgent(BUDDY_AGENT_ID),
      recommendation,
      score,
      scenarioMetrics,
      skillVersionId: assessedVersion?.id || '',
      skillHash: assessedVersion?.skill_hash || sha256Text(this.org.readSkill(buddy)),
      sourceReviewId,
    });
    let rollback = { status: 'not_required' };
    const failureRate = taskCount ? failureCount / taskCount : 0;
    if (!dryRun && rating === 'observe' && taskCount >= 3) {
      const version = this.bestAssessedSkillVersion(BUDDY_AGENT_ID, { excludeReviewId: reviewId });
      const marker = this.store.settingGet('buddy:last_skill_rollback_version_id', '');
      if (!version) {
        rollback = { status: 'skipped', reason: 'no_qualified_assessed_skill_version' };
      } else if (version.skill_hash === sha256Text(this.org.readSkill(buddy))) {
        rollback = { status: 'skipped', reason: 'best_assessed_skill_already_active', skillVersionId: version.id, sourceReviewId: version.review_id };
      } else if (marker === version.id) {
        rollback = { status: 'skipped', reason: 'skill_version_already_rolled_back', skillVersionId: version.id };
      } else {
        rollback = this.rollbackSkillVersion({
          skillVersionId: version.id,
          reviewerId: 'buddy_periodic_assessment',
          reason: `Buddy agent scenario assessment ${reviewId} scored ${score}. Restoring best qualified assessed Skill from review ${version.review_id} (score ${version.score}).`,
        });
        this.store.settingSet('buddy:last_skill_rollback_version_id', version.id);
      }
    }
    if (!dryRun) this.store.settingSet('buddy:last_assessment_at', nowIso());
    return {
      agentId: BUDDY_AGENT_ID,
      departmentId: BUDDY_DEPARTMENT_ID,
      status: 'completed',
      reviewId,
      rating,
      taskCount,
      successCount,
      failureCount,
      failureRate,
      score,
      scenarioMetrics,
      assessedSkillVersionId: assessedVersion?.id || '',
      rollback,
      policy: 'scenario_assessment_best_skill_rollback_only',
    };
  }

  labRecruitmentMemoryDigest() {
    const agents = this.org.list().agents.filter((agent) => !isBuddyAgent(agent));
    const entries = agents.map((agent) => {
      const typed = all(
        this.db,
        `SELECT memory_type, content, confidence
         FROM typed_memories
         WHERE agent_id = ? AND status = 'active' AND privacy_level = 'public_reusable'
         ORDER BY confidence DESC, updated_at DESC LIMIT 12`,
        [agent.id],
      );
      return {
        agentId: agent.id,
        departmentId: agent.departmentId,
        role: isGeneralAgent(agent) ? 'general_recruitment_participant' : 'department_agent_evidence_source',
        durableContext: clipText(this.org.readMemory(agent), 3500),
        typedMemories: typed.map((row) => ({
          memoryType: row.memory_type,
          content: clipText(row.content, 500),
          confidence: Number(row.confidence || 0),
        })),
      };
    });
    return {
      entries,
      digest: entries.map((entry) => [
        `### ${entry.agentId} (${entry.departmentId})`,
        `Participation: ${entry.role}`,
        clipText(entry.durableContext || 'No governed durable context.', 3500),
        entry.typedMemories.length
          ? `Reviewed reusable typed memories:\n${entry.typedMemories.map((item) => `- ${item.memoryType}: ${item.content}`).join('\n')}`
          : 'No active reusable typed memories.',
      ].join('\n')).join('\n\n'),
    };
  }

  runGeneralAgentRecruitmentParticipation({ force = false, dryRun = false } = {}) {
    const intervalHours = Math.max(1, Number(process.env.JANUS_GENERAL_AGENT_ASSESSMENT_INTERVAL_HOURS || 24));
    const lastAt = this.store.settingGet('general_agent:last_recruitment_review_at', '');
    const lastMs = Date.parse(lastAt);
    if (!force && Number.isFinite(lastMs) && Date.now() - lastMs < intervalHours * 60 * 60 * 1000) {
      return { agentId: GENERAL_AGENT_ID, departmentId: 'general', status: 'skipped', reason: 'recruitment_review_not_due' };
    }
    const agent = this.org.agent(GENERAL_AGENT_ID);
    if (!agent) return { agentId: GENERAL_AGENT_ID, departmentId: 'general', status: 'skipped', reason: 'general_agent_missing' };
    const messageCount = Number(get(
      this.db,
      `SELECT COUNT(*) AS count FROM messages
       WHERE agent_id = ? AND role IN ('user', 'assistant') AND visible = 1 AND created_at > ?`,
      [GENERAL_AGENT_ID, lastAt || '1970-01-01T00:00:00.000Z'],
    )?.count || 0);
    const memoryDigest = this.labRecruitmentMemoryDigest();
    const capabilityEvidenceCount = messageCount + memoryDigest.entries.reduce((sum, entry) => sum + entry.typedMemories.length, 0);
    const eventId = this.store.recordGovernanceEvent({
      departmentId: 'general',
      agentId: GENERAL_AGENT_ID,
      eventType: 'general_agent_recruitment_participation',
      status: capabilityEvidenceCount >= DEFAULT_MIN_EVIDENCE_MESSAGES ? 'ready' : 'collecting_evidence',
      evidenceCount: capabilityEvidenceCount,
      confidence: Math.min(0.95, capabilityEvidenceCount / Math.max(DEFAULT_MIN_EVIDENCE_MESSAGES * 2, 1)),
      rationale: 'The standalone Generalist participates only in recruitment deliberation using recent Generalist and department Agent memory evidence; it is not assessed and cannot be promoted, demoted, placed on probation, merged, retired, or dismissed.',
      payload: {
        memorySourceCount: memoryDigest.entries.length,
        generalMessageCount: messageCount,
        allowedActions: ['new_agent', 'new_department'],
        excludedActions: ['performance_assessment', 'promote_agent', 'demote_agent', 'probation_agent', 'merge_agents', 'retire_agent'],
      },
      sourceReviewId: newId('general_recruitment'),
    });
    if (!dryRun) this.store.settingSet('general_agent:last_recruitment_review_at', nowIso());
    return {
      agentId: GENERAL_AGENT_ID,
      departmentId: 'general',
      status: 'completed',
      eventId,
      messageCount,
      capabilityEvidenceCount,
      memorySourceCount: memoryDigest.entries.length,
      organizationPolicy: 'recruitment_only_no_assessment_or_career_actions',
    };
  }

  runGeneralAgentPerformanceAssessment(options = {}) {
    return { ...this.runGeneralAgentRecruitmentParticipation(options), assessmentExcluded: true };
  }

  decayTypedMemories() {
    const before = get(this.db, "SELECT COUNT(*) AS count FROM typed_memories WHERE status = 'active'")?.count || 0;
    run(
      this.db,
      `UPDATE typed_memories
       SET confidence = MAX(0.1, confidence * 0.99), updated_at = updated_at
       WHERE status = 'active'
         AND hit_count = 0
         AND updated_at < datetime('now', '-30 days')`,
    );
    run(
      this.db,
      `UPDATE typed_memories
       SET status = 'archived', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE status = 'active'
         AND confidence < 0.2
         AND hit_count = 0
         AND updated_at < datetime('now', '-90 days')`,
    );
    const after = get(this.db, "SELECT COUNT(*) AS count FROM typed_memories WHERE status = 'active'")?.count || 0;
    return { activeBefore: Number(before), activeAfter: Number(after) };
  }

  async runAgentEvolution({ agent, dryRun = false, llmDiagnosis = true, autoApply = true, onProgress = null }) {
    const runId = newId('evo');
    const hr = this.org.hrForDepartment(agent.departmentId);
    const emitAgentProgress = (stage, status, label, detail = '', extra = {}) => emitEvolutionProgress(onProgress, {
      stage,
      status,
      label,
      detail,
      scope: 'agent',
      agentRunId: runId,
      agentId: agent.id,
      agentName: agent.name || agent.id,
      departmentId: agent.departmentId,
      ...extra,
    });
    emitAgentProgress('evidence', 'running', '证据读取', `${agent.name || agent.id}：读取最近可见会话。`);
    if (!agentCanSelfEvolve(agent)) {
      run(
        this.db,
        `INSERT INTO evolution_runs (
          id, agent_id, agent_family_id, evolution_scope, algorithm_version,
          department_id, hr_id, evidence_message_count, status
         ) VALUES (?, ?, ?, 'legacy', 'legacy_v1', ?, ?, 0, 'running')`,
        [runId, agent.id, agent.id, agent.departmentId, hr?.id || ''],
      );
      const reason = `Self-evolution is disabled for lifecycle status ${agent.lifecycleStatus || 'unknown'} (${agent.lifecycleRole || 'agent'}).`;
      emitAgentProgress('evidence', 'skipped', '证据读取', reason);
      this.finishEvolutionRun(runId, 'skipped', '', reason);
      return { agentId: agent.id, runId, status: 'skipped', evidenceMessageCount: 0, reason };
    }
    const evidence = codexEvidenceForAgent({
      db: this.db,
      store: this.store,
      root: this.root,
      agentId: agent.id,
      limit: 40,
    });
    const minEvidence = Math.max(DEFAULT_MIN_EVIDENCE_MESSAGES, agent.minMessagesForEvolution || 0);
    run(
      this.db,
      `INSERT INTO evolution_runs (
        id, agent_id, agent_family_id, evolution_scope, algorithm_version,
        department_id, hr_id, evidence_message_count, status
       ) VALUES (?, ?, ?, 'legacy', 'legacy_v1', ?, ?, ?, 'running')`,
      [runId, agent.id, agent.id, agent.departmentId, hr?.id || '', evidence.length],
    );

    if (evidence.length < minEvidence) {
      const reason = `Only ${evidence.length} visible messages available; need ${minEvidence}.`;
      emitAgentProgress('evidence', 'skipped', '证据读取', reason, { evidenceCount: evidence.length, minEvidence });
      this.finishEvolutionRun(runId, 'skipped', '', reason);
      return { agentId: agent.id, runId, status: 'skipped', evidenceMessageCount: evidence.length };
    }

    emitAgentProgress('evidence', 'success', '证据读取', `${evidence.length} 条可见消息满足门槛。`, { evidenceCount: evidence.length, minEvidence });
    emitAgentProgress('diagnosis', 'running', '轨迹诊断', `${agent.name || agent.id}：运行 deterministic / hybrid diagnosis。`);
    const diagnostic = llmDiagnosis
      ? await hybridDiagnoseAgentEvidence({
          root: this.root, agent, evidence, llm: true,
          executionContext: this.modelExecutionContext(agent, 'evolution_diagnosis'),
        })
      : diagnoseAgentEvidence({ agentId: agent.id, departmentId: agent.departmentId, evidence });
    emitAgentProgress('diagnosis', 'success', '轨迹诊断', `${diagnostic.primary_layer || 'skill_procedure'} / ${diagnostic.failure_type || 'unknown'}`, { diagnosticLayer: diagnostic.primary_layer, confidence: diagnostic.confidence });
    const skill = this.org.readSkill(agent);
    const memory = this.org.readMemory(agent);
    const prompt = buildScheduledAgentEvolutionPrompt({
      agent,
      memory,
      skill,
      evidenceRows: evidence,
      diagnostic,
    });
    const proposalDir = evolutionDir(this.root, agent);
    ensureDirSync(proposalDir);
    const proposalPath = path.join(proposalDir, `${runId}.md`);

    try {
      emitAgentProgress('proposal', 'running', 'Proposal', `${agent.name || agent.id}：Janus 模型正在生成 Skill / Agent 持久上下文 proposal。`);
      const proposal = await runCodexExec({
        prompt,
        agentId: agent.id,
        role: 'agent',
        root: this.root,
        sandbox: 'read-only',
        dryRun,
        executionContext: this.modelExecutionContext(agent, 'evolution_proposal', { skill, memory, metadata: { evolutionRunId: runId } }),
      });
      writeTextAtomicSync(proposalPath, proposal);
      emitAgentProgress('proposal', 'success', 'Proposal', `proposal 已写入 ${path.basename(proposalPath)}。`, { proposalPath });
      emitAgentProgress('gate', 'running', 'Gate 裁决', '后端正在校验格式、范围、隐私和诊断一致性。');
      const validationErrors = validateAgentProposal(agent, proposal);
      const gate = scoreEvolutionGate({
        proposal,
        diagnostic,
        validationErrors,
        calibration: this.loadGateCalibration(),
      });
      emitAgentProgress('gate', gate.status === 'passed' ? 'success' : 'failed', 'Gate 裁决', `${gate.status} / score ${gate.score}`, { gateStatus: gate.status, gateScore: gate.score, reasons: gate.reasons || [] });
      this.recordEvolutionArchive({
        runId,
        agent,
        proposalPath,
        proposalText: proposal,
        diagnostic,
        gate,
        applied: false,
      });
      this.recordWorkflowCreditFromDiagnostic({ runId, agent, diagnostic });
      if (gate.status !== 'passed') {
        this.finishEvolutionRun(runId, 'failed', proposalPath, `Evolution gate failed: ${gate.reasons.join('; ')}`);
        return { agentId: agent.id, runId, status: 'failed', proposalPath, gate };
      }
      let currentProposal = proposal;
      let currentProposalPath = proposalPath;
      let currentGate = gate;
      let revisionAttempts = 0;
      const hrReviews = [];
      const evaluatorLabel = isBuddyAgent(agent) ? '独立 uBuddy evaluator' : isGeneralAgent(agent) ? '独立 Generalist evaluator' : 'HR 复核';
      emitAgentProgress('hr', 'running', evaluatorLabel, `${isBuddyAgent(agent) ? 'buddy_evaluator' : isGeneralAgent(agent) ? 'general_agent_evaluator' : hr?.name || hr?.id || 'HR'} 正在复核 proposal。`);
      let hrReview = await this.reviewAgentEvolutionProposal({
        agent,
        hr,
        runId,
        proposal: currentProposal,
        proposalPath: currentProposalPath,
        diagnostic,
        gate: currentGate,
        dryRun,
      });
      hrReviews.push(hrReview);
      emitAgentProgress('hr', hrReview.decision === 'full' ? 'success' : hrReview.decision === 'partial' ? 'running' : 'failed', evaluatorLabel, `${hrReview.decision}: ${String(hrReview.rationale || '').slice(0, 160)}`, { decision: hrReview.decision });

      while (hrReview.decision === 'partial' && revisionAttempts < DEFAULT_HR_REVISION_ATTEMPTS) {
        revisionAttempts += 1;
        const revision = await this.reviseAgentEvolutionProposal({
          agent,
          runId,
          previousProposal: currentProposal,
          previousProposalPath: currentProposalPath,
          hrReview,
          diagnostic,
          gate: currentGate,
          attempt: revisionAttempts,
          dryRun,
        });
        currentProposal = revision.proposal;
        currentProposalPath = revision.proposalPath;
        currentGate = revision.gate;
        if (currentGate.status !== 'passed') {
          this.finishEvolutionRun(runId, 'failed', currentProposalPath, `Revised evolution gate failed: ${currentGate.reasons.join('; ')}`);
          return {
            agentId: agent.id,
            runId,
            status: 'failed',
            proposalPath: currentProposalPath,
            gate: currentGate,
            hrReview,
            hrReviews,
            revisionAttempts,
            applied: false,
          };
        }
        hrReview = await this.reviewAgentEvolutionProposal({
          agent,
          hr,
          runId,
          proposal: currentProposal,
          proposalPath: currentProposalPath,
          diagnostic,
          gate: currentGate,
          dryRun,
        });
        hrReviews.push(hrReview);
      }

      if (hrReview.decision !== 'full') {
        const status = hrReview.decision === 'partial' ? 'proposed' : 'failed';
        const summary = hrReview.decision === 'partial'
          ? `${evaluatorLabel} marked self-evolution partially applicable after ${revisionAttempts} revision attempt(s); revision required: ${hrReview.requiredRevision || hrReview.rationale}`
          : `${evaluatorLabel} rejected self-evolution proposal: ${hrReview.rationale}`;
        this.finishEvolutionRun(runId, status, currentProposalPath, summary);
        return { agentId: agent.id, runId, status, proposalPath: currentProposalPath, gate: currentGate, hrReview, hrReviews, revisionAttempts, applied: false };
      }
      this.finishEvolutionRun(runId, 'proposed', currentProposalPath, revisionAttempts
        ? `Self-evolution proposal revised ${revisionAttempts} time(s); gate passed; ${evaluatorLabel} approved full applicability.`
        : `Self-evolution proposal created; gate passed; ${evaluatorLabel} approved full applicability.`);
      let applied = false;
      if (autoApply && !dryRun) {
        emitAgentProgress('apply', 'running', '应用写入', `${agent.name || agent.id}：写入源 SKILL.md / Agent 持久上下文 MEMORY.md。`);
        await this.applyAgentEvolution({ agent, runId, proposal: currentProposal, proposalPath: currentProposalPath, diagnostic, gate: currentGate });
        emitAgentProgress('apply', 'success', '应用写入', `${agent.name || agent.id}：Skill / Agent 持久上下文已更新并快照。`);
        applied = true;
      } else {
        emitAgentProgress('apply', 'skipped', '应用写入', dryRun ? 'Dry run 不写入文件。' : 'autoApply 已关闭，保留 proposal。');
      }
      return { agentId: agent.id, runId, status: applied ? 'applied' : 'proposed', proposalPath: currentProposalPath, gate: currentGate, hrReview, hrReviews, revisionAttempts, applied };
    } catch (error) {
      emitAgentProgress('proposal', 'failed', '自进化失败', progressDetailForError(error));
      this.finishEvolutionRun(runId, 'failed', proposalPath, String(error.message || error));
      return { agentId: agent.id, runId, status: 'failed', error: String(error.message || error), proposalPath };
    }
  }

  finishEvolutionRun(runId, status, proposalPath, summary) {
    run(
      this.db,
      `UPDATE evolution_runs
       SET status = ?, proposal_path = COALESCE(NULLIF(?, ''), proposal_path),
           summary = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
      [status, proposalPath || '', clipText(summary || '', 1000), nowIso(), nowIso(), runId],
    );
  }

  recordEvolutionArchive({ runId, agent, proposalPath, proposalText, diagnostic, gate, applied }) {
    const skillPath = agentSkillPath(this.root, agent);
    const memoryPath = agentMemoryPath(this.root, agent);
    run(
      this.db,
      `INSERT INTO evolution_archives (
        id, run_id, agent_id, agent_family_id, evolution_scope, department_id, proposal_path, proposal_hash,
        diagnostics_json, gate_status, gate_score, gate_json, applied,
        pre_skill_hash, pre_memory_hash
      ) VALUES (?, ?, ?, ?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('archive'),
        runId,
        agent.id,
        agent.id,
        agent.departmentId,
        proposalPath,
        sha256Text(proposalText),
        JSON.stringify(diagnostic),
        gate.status,
        gate.score,
        JSON.stringify(gate),
        applied ? 1 : 0,
        sha256Text(readText(skillPath, '')),
        sha256Text(readText(memoryPath, '')),
      ],
    );
  }

  recordWorkflowCreditFromDiagnostic({ runId, agent, diagnostic }) {
    const layer = String(diagnostic.primary_layer || 'skill_procedure');
    let responsibility = Number(diagnostic.confidence || 0.5);
    if (['intent_alignment', 'tool_runtime', 'artifact_contract', 'evidence_quality', 'memory_governance'].includes(layer)) {
      responsibility = Math.min(0.95, Math.max(0.55, responsibility));
    }
    run(
      this.db,
      `INSERT INTO workflow_credit_assignments (
        id, run_id, department_id, agent_id, workflow_step, failure_type,
        responsibility, evidence_summary, recommendation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId('wfcredit'),
        runId,
        agent.departmentId,
        agent.id,
        layer,
        String(diagnostic.failure_type || '').slice(0, 120),
        Number(responsibility.toFixed(3)),
        (diagnostic.signals || []).map(String).join('; ').slice(0, 1000),
        String(diagnostic.recommendation || '').slice(0, 1000),
      ],
    );
  }

  async reviseAgentEvolutionProposal({ agent, runId, previousProposal, previousProposalPath, hrReview, diagnostic, gate, attempt, dryRun = false }) {
    const proposalDir = evolutionDir(this.root, agent);
    ensureDirSync(proposalDir);
    const revisionPath = path.join(proposalDir, `${runId}-revision-${attempt}.md`);
    const revisionPrompt = buildAgentEvolutionRevisionPrompt({
      agent,
      previousProposal,
      hrReview,
      diagnostic,
      gate,
      skill: this.org.readSkill(agent),
      memory: this.org.readMemory(agent),
      attempt,
    });
    const proposal = await runCodexExec({
      prompt: revisionPrompt,
      agentId: agent.id,
      role: 'agent-revision',
      root: this.root,
      sandbox: 'read-only',
      dryRun,
      executionContext: this.modelExecutionContext(agent, 'evolution_revision', { metadata: { evolutionRunId: runId, attempt } }),
    });
    writeTextAtomicSync(revisionPath, proposal);
    const validationErrors = validateAgentProposal(agent, proposal);
    const revisedGate = scoreEvolutionGate({
      proposal,
      diagnostic,
      validationErrors,
      calibration: this.loadGateCalibration(),
    });
    this.recordEvolutionArchive({
      runId,
      agent,
      proposalPath: revisionPath,
      proposalText: proposal,
      diagnostic,
      gate: revisedGate,
      applied: false,
    });
    this.store.recordGovernanceEvent({
      departmentId: agent.departmentId,
      agentId: agent.id,
      eventType: 'agent_evolution_revision',
      status: revisedGate.status,
      evidenceCount: Number(diagnostic.evidence_messages || diagnostic.evidenceMessageCount || 0),
      confidence: revisedGate.status === 'passed' ? 0.7 : 0.3,
      rationale: revisedGate.status === 'passed'
        ? `Revision attempt ${attempt} passed deterministic gate after HR partial review.`
        : `Revision attempt ${attempt} failed deterministic gate: ${revisedGate.reasons.join('; ')}`,
      payload: {
        runId,
        attempt,
        previousProposalPath,
        proposalPath: revisionPath,
        previousHrReviewId: hrReview.id || '',
        gateStatus: revisedGate.status,
        gateScore: revisedGate.score,
      },
      sourceReviewId: runId,
    });
    return { proposal, proposalPath: revisionPath, gate: revisedGate };
  }

  async reviewAgentEvolutionProposal({ agent, hr, runId, proposal, proposalPath, diagnostic, gate, dryRun = false }) {
    const department = this.org.department(agent.departmentId);
    const skill = this.org.readSkill(agent);
    const memory = this.org.readMemory(agent);
    let reviewerOutput = '';
    let review;
    let reviewerId = hr?.id || '';
    try {
      if (isBuddyAgent(agent)) {
        reviewerId = 'buddy_evaluator';
        reviewerOutput = dryRun
          ? JSON.stringify({
              decision: 'full',
              rationale: 'Dry-run independent uBuddy evaluator permits pipeline validation without applying model judgment.',
              required_revision: '',
              risks: ['dry-run evaluator result'],
            })
          : await runCodexExec({
              prompt: buildBuddyEvolutionEvaluatorPrompt({
                agent,
                proposal,
                diagnostic,
                gate,
                skill,
                memory,
              }),
              agentId: reviewerId,
              role: 'buddy-evolution-evaluator',
              root: this.root,
              sandbox: 'read-only',
              executionContext: this.modelExecutionContext(reviewerId, 'buddy_evolution_evaluator', {
                skill,
                memory,
                metadata: { evolutionRunId: runId, reviewedAgentId: agent.id, independentEvaluator: true },
              }),
            });
        review = parseAgentEvolutionHrReview(reviewerOutput);
      } else if (isGeneralAgent(agent)) {
        reviewerId = 'general_agent_evaluator';
        reviewerOutput = dryRun
          ? JSON.stringify({
              decision: 'full',
              rationale: 'Dry-run independent Generalist evaluator permits pipeline validation.',
              required_revision: '',
              risks: ['dry-run evaluator result'],
            })
          : await runCodexExec({
              prompt: buildGeneralAgentEvolutionEvaluatorPrompt({ agent, proposal, diagnostic, gate, skill, memory }),
              agentId: reviewerId,
              role: 'general-agent-evolution-evaluator',
              root: this.root,
              sandbox: 'read-only',
              executionContext: this.modelExecutionContext(reviewerId, 'general_agent_evolution_evaluator', {
                skill,
                memory,
                metadata: { evolutionRunId: runId, reviewedAgentId: agent.id, independentEvaluator: true },
              }),
            });
        review = parseAgentEvolutionHrReview(reviewerOutput);
      } else {
        if (!hr) throw new Error(`No HR agent found for department ${agent.departmentId}.`);
        reviewerOutput = dryRun
          ? JSON.stringify({
              decision: 'full',
              rationale: 'Dry-run HR gate permits validation without applying real model judgment.',
              required_revision: '',
              risks: ['dry-run review is not production approval'],
            })
          : await runCodexExec({
              prompt: buildAgentEvolutionHrReviewPrompt({
                department,
                hr,
                agent,
                proposal,
                diagnostic,
                gate,
                skill,
                memory,
              }),
              agentId: hr.id,
              role: 'agent-evolution-hr-review',
              root: this.root,
              sandbox: 'read-only',
              executionContext: this.modelExecutionContext(hr, 'evolution_hr_review', { metadata: { evolutionRunId: runId, reviewedAgentId: agent.id } }),
            });
        review = parseAgentEvolutionHrReview(reviewerOutput);
      }
    } catch (error) {
      reviewerOutput = reviewerOutput || String(error.message || error);
      const reviewerLabel = isBuddyAgent(agent) ? 'Independent uBuddy evaluator' : isGeneralAgent(agent) ? 'Independent Generalist evaluator' : 'HR review';
      review = {
        decision: 'reject',
        rationale: `${reviewerLabel} failed: ${String(error.message || error)}`,
        requiredRevision: `Retry the ${reviewerLabel} before applying this proposal.`,
        risks: ['proposal was not applied because independent approval was unavailable'],
      };
    }

    const reviewId = newId('agentreview');
    run(
      this.db,
      `INSERT INTO agent_evolution_reviews (
        id, run_id, agent_id, department_id, hr_id, decision,
        rationale, required_revision, risks_json, reviewer_output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reviewId,
        runId,
        agent.id,
        agent.departmentId,
        reviewerId,
        review.decision,
        clipText(review.rationale, 2000),
        clipText(review.requiredRevision, 2000),
        JSON.stringify(review.risks || []),
        clipText(reviewerOutput, 12_000),
      ],
    );
    this.store.recordGovernanceEvent({
      departmentId: agent.departmentId,
      agentId: agent.id,
      eventType: isBuddyAgent(agent) ? 'buddy_agent_evolution_review' : isGeneralAgent(agent) ? 'general_agent_evolution_review' : 'agent_evolution_hr_review',
      status: review.decision,
      evidenceCount: Number(diagnostic.evidence_messages || diagnostic.evidenceMessageCount || 0),
      confidence: review.decision === 'full' ? 0.8 : review.decision === 'partial' ? 0.55 : 0.4,
      rationale: review.rationale,
      payload: {
        reviewId,
        runId,
        proposalPath,
        gateStatus: gate.status,
        gateScore: gate.score,
        requiredRevision: review.requiredRevision,
        risks: review.risks,
        reviewerId,
        independentEvaluator: isBuddyAgent(agent) || isGeneralAgent(agent),
      },
      sourceReviewId: runId,
    });
    return {
      id: reviewId,
      ...review,
      reviewerId,
      reviewerType: isBuddyAgent(agent) ? 'buddy_evaluator' : isGeneralAgent(agent) ? 'general_agent_evaluator' : 'department_hr',
    };
  }

  async applyAgentEvolution({ agent, runId, proposal, proposalPath, diagnostic, gate }) {
    if (!agentCanSelfEvolve(agent) || agent.permissions?.canWriteLongTermMemory === false) {
      throw new Error(`Agent ${agent.id} is not allowed to apply self-evolution in lifecycle status ${agent.lifecycleStatus || 'unknown'}.`);
    }
    const skillPath = agentSkillPath(this.root, agent);
    const memoryPath = agentMemoryPath(this.root, agent);
    const beforeSkill = readText(skillPath, '');
    const beforeMemory = readText(memoryPath, '');

    const replacement = extractMarkdownSection(proposal, 'Proposed memory replacement');
    const memoryPatch = extractMarkdownSection(proposal, 'Proposed memory patch');
    let nextMemory = beforeMemory;
    if (replacement && !/^no-op$/i.test(replacement.trim())) {
      nextMemory = sanitizeMemoryReplacement(replacement, agent.id);
    } else if (memoryPatch && !/^no-op$/i.test(memoryPatch.trim())) {
      nextMemory = applyMemoryPatchToSchema(beforeMemory, memoryPatch);
    }
    const skillPatch = extractMarkdownSection(proposal, 'Proposed skill patch');
    let nextSkill = beforeSkill;
    if (skillPatch && !/^no-op$/i.test(skillPatch.trim())) {
      nextSkill = applySkillPatch(beforeSkill, skillPatch);
    }

    const stagingDir = path.join(tmpDir(this.root), 'evolution-staging', runId);
    const stagedSkillPath = path.join(stagingDir, 'SKILL.md');
    const stagedMemoryPath = path.join(stagingDir, 'MEMORY.md');
    ensureDirSync(stagingDir);
    writeTextAtomicSync(stagedSkillPath, nextSkill);
    writeTextAtomicSync(stagedMemoryPath, nextMemory);
    const journalId = newId('applyjournal');
    run(
      this.db,
      `INSERT INTO evolution_apply_journal (
        id, run_id, agent_id, department_id, status, skill_path, memory_path,
        staged_skill_path, staged_memory_path, before_skill_hash, before_memory_hash,
        staged_skill_hash, staged_memory_hash
      ) VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        journalId,
        runId,
        agent.id,
        agent.departmentId,
        skillPath,
        memoryPath,
        stagedSkillPath,
        stagedMemoryPath,
        sha256Text(beforeSkill),
        sha256Text(beforeMemory),
        sha256Text(nextSkill),
        sha256Text(nextMemory),
      ],
    );

    const memoryRecordContext = {
      ownerId: agent.id,
      departmentId: agent.departmentId,
      agentId: agent.id,
      sourceId: runId,
      evidenceCount: diagnostic.evidence_messages || 0,
    };
    recordRegressionEvalCases(this.db, {
      runId,
      agent,
      proposal,
      proposalHash: sha256Text(proposal),
      skillPath: stagedSkillPath,
      memoryPath: stagedMemoryPath,
    });
    this.recordHoldoutRegressionCases({ runId, agent, skillPath: stagedSkillPath, memoryPath: stagedMemoryPath });

    try {
      const regression = await this.runRegressionEvals({
        runId,
        limit: 100,
        agentLookup: {
          [agent.id]: { departmentId: agent.departmentId, skillPath: stagedSkillPath, memoryPath: stagedMemoryPath },
          [`${agent.departmentId}:${agent.id}`]: { departmentId: agent.departmentId, skillPath: stagedSkillPath, memoryPath: stagedMemoryPath },
        },
      });
      const abReplay = REGRESSION_AB_REPLAY_ENABLED
        ? await this.runEvolutionAbReplay({ agent, runId, beforeSkill, beforeMemory, nextSkill, nextMemory })
        : { status: 'skipped', total: 0, passed: 0, failed: 0, results: [] };
      const regressionBundle = { ...regression, abReplay };
      run(
        this.db,
        `UPDATE evolution_apply_journal SET status = ?, regression_json = ?, updated_at = ? WHERE id = ?`,
        [regression.total > 0 && regression.failed === 0 && regression.skipped === 0 && abReplay.failed === 0 ? 'regression_passed' : 'regression_failed', JSON.stringify(regressionBundle), nowIso(), journalId],
      );
      if (regression.total === 0 || regression.failed > 0 || regression.skipped > 0 || abReplay.failed > 0) {
        this.finishEvolutionRun(runId, 'regression_failed', proposalPath, `Regression gate rejected apply: total=${regression.total}, failed=${regression.failed}, skipped=${regression.skipped}, ab_failed=${abReplay.failed}.`);
        throw new Error(`Regression gate rejected self-evolution for ${agent.id}.`);
      }

      const skillBeforeSnapshotPath = this.snapshotEvolutionFile(agent, runId, 'skill-before', beforeSkill);
      const memoryBeforeSnapshotPath = this.snapshotEvolutionFile(agent, runId, 'memory-before', beforeMemory);
      this.snapshotSkill(agent, runId, beforeSkill);
      const records = replacement && !/^no-op$/i.test(replacement.trim())
        ? extractTypedMemoryRecords(nextMemory, memoryRecordContext)
        : extractTypedMemoryRecordsFromPatch(memoryPatch, memoryRecordContext);

      run(
        this.db,
        `UPDATE evolution_apply_journal
         SET status = 'committing', skill_before_snapshot_path = ?, memory_before_snapshot_path = ?, updated_at = ?
         WHERE id = ?`,
        [skillBeforeSnapshotPath, memoryBeforeSnapshotPath, nowIso(), journalId],
      );
      this.db.exec('BEGIN IMMEDIATE');
      try {
        writeTextAtomicSync(memoryPath, nextMemory);
        writeTextAtomicSync(skillPath, nextSkill);
        for (const record of records) upsertTypedMemory(this.db, record);
        run(
          this.db,
          `UPDATE evolution_archives
           SET applied = 1, post_skill_hash = ?, post_memory_hash = ?
           WHERE run_id = ? AND proposal_path = ?`,
          [sha256Text(nextSkill), sha256Text(nextMemory), runId, proposalPath],
        );
        this.finishEvolutionRun(runId, 'applied', proposalPath, 'Self-evolution committed after staged regression approval.');
        run(
          this.db,
          `UPDATE evolution_apply_journal
           SET status = 'committed', updated_at = ?, completed_at = ? WHERE id = ?`,
          [nowIso(), nowIso(), journalId],
        );
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        writeTextAtomicSync(skillPath, beforeSkill);
        writeTextAtomicSync(memoryPath, beforeMemory);
        run(
          this.db,
          `UPDATE evolution_apply_journal
           SET status = 'rolled_back', error_text = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
          [clipText(error.message || String(error), 2000), nowIso(), nowIso(), journalId],
        );
        throw error;
      }

      this.snapshotEvolutionFile(agent, runId, 'skill-after', nextSkill);
      this.snapshotEvolutionFile(agent, runId, 'memory-after', nextMemory);
      return { skillPath, memoryPath, gate, regression, journalId };
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  recordHoldoutRegressionCases({ runId, agent, skillPath, memoryPath }) {
    const rows = all(
      this.db,
      `SELECT * FROM evolution_holdout_evals
       WHERE active = 1 AND (agent_id = ? OR (agent_id = '' AND department_id = ?))
       ORDER BY created_at ASC LIMIT 20`,
      [agent.id, agent.departmentId],
    );
    rows.forEach((row, index) => {
      run(
        this.db,
        `INSERT INTO evolution_regression_evals (
          id, run_id, agent_id, department_id, case_index, case_text, input_text,
          expected_text, replay_spec_json, source_proposal_hash, skill_hash, memory_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('holdouteval'), runId, agent.id, agent.departmentId, 1000 + index,
          row.case_text, row.input_text, row.expected_text, row.replay_spec_json,
          `holdout:${row.id}`, sha256Text(readText(skillPath, '')), sha256Text(readText(memoryPath, '')),
        ],
      );
    });
    return rows.length;
  }

  recordHoldoutEval({ agentId = '', departmentId = '', caseText, inputText = '', expectedText = '', replaySpec = {}, sourceKind = 'human_holdout' } = {}) {
    if (!String(caseText || '').trim()) throw new Error('Holdout eval requires caseText.');
    const id = newId('holdout');
    run(
      this.db,
      `INSERT INTO evolution_holdout_evals (
        id, agent_id, department_id, case_text, input_text, expected_text, replay_spec_json, source_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, agentId, departmentId, String(caseText).trim(), String(inputText || ''), String(expectedText || ''), JSON.stringify(replaySpec || {}), sourceKind],
    );
    return { id, agentId, departmentId, caseText: String(caseText).trim(), sourceKind };
  }

  async runEvolutionAbReplay({ agent, runId, beforeSkill, beforeMemory, nextSkill, nextMemory }) {
    const evals = all(
      this.db,
      `SELECT * FROM evolution_regression_evals WHERE run_id = ? ORDER BY case_index ASC LIMIT 3`,
      [runId],
    );
    const results = [];
    for (const item of evals) {
      const input = item.input_text || item.case_text;
      const behaviorPrompt = (label, skill, memory) => `Execute this regression task as agent ${agent.id} using only the supplied candidate instructions. Return the task answer only.\n\nVariant: ${label}\nTask: ${input}\nExpected behavior: ${item.expected_text}\n\nSKILL:\n${clipText(skill, 10000)}\n\nMEMORY:\n${clipText(memory, 5000)}`;
      const beforeOutput = await runCodexExec({
        prompt: behaviorPrompt('before', beforeSkill, beforeMemory),
        agentId: agent.id,
        role: 'regression-ab-before',
        root: this.root,
        sandbox: 'read-only',
        executionContext: this.modelExecutionContext(agent, 'regression_ab_before', { skill: beforeSkill, memory: beforeMemory, metadata: { evolutionRunId: runId, evalId: item.id } }),
      });
      const afterOutput = await runCodexExec({
        prompt: behaviorPrompt('after', nextSkill, nextMemory),
        agentId: agent.id,
        role: 'regression-ab-after',
        root: this.root,
        sandbox: 'read-only',
        executionContext: this.modelExecutionContext(agent, 'regression_ab_after', { skill: nextSkill, memory: nextMemory, metadata: { evolutionRunId: runId, evalId: item.id } }),
      });
      const judgeRaw = await runCodexExec({
        prompt: `Compare two outputs for the same hidden regression task. Return JSON only: {"winner":"before|after|tie","before_score":0.0,"after_score":0.0,"rationale":"short"}.\nTask: ${input}\nExpected: ${item.expected_text}\nBefore output: ${clipText(beforeOutput, 5000)}\nAfter output: ${clipText(afterOutput, 5000)}`,
        agentId: agent.id,
        role: 'regression-ab-judge',
        root: this.root,
        sandbox: 'read-only',
        executionContext: this.modelExecutionContext(agent, 'regression_ab_judge', { metadata: { evolutionRunId: runId, evalId: item.id } }),
      });
      const judge = safeJsonParse(String(judgeRaw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''), {}) || {};
      const passed = ['after', 'tie'].includes(judge.winner) && Number(judge.after_score || 0) >= Number(judge.before_score || 0);
      run(
        this.db,
        `INSERT INTO evolution_ab_replays (id, run_id, agent_id, eval_id, before_output, after_output, judge_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('abreplay'), runId, agent.id, item.id, clipText(beforeOutput, 12000), clipText(afterOutput, 12000), JSON.stringify(judge), passed ? 'passed' : 'failed'],
      );
      results.push({ evalId: item.id, status: passed ? 'passed' : 'failed', judge });
    }
    return {
      status: results.some((item) => item.status === 'failed') ? 'failed' : 'passed',
      total: results.length,
      passed: results.filter((item) => item.status === 'passed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    };
  }

  snapshotEvolutionFile(agent, runId, label, text) {
    const dir = path.join(agent.path, 'evolution_archive', 'snapshots');
    ensureDirSync(dir);
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '')}-${runId}-${label}.md`);
    writeTextAtomicSync(file, text || '');
    return file;
  }

  snapshotSkill(agent, runId, skillText) {
    const dir = skillVersionsDir(this.root, agent);
    ensureDirSync(dir);
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '')}-${runId}.md`);
    writeTextAtomicSync(file, skillText);
    run(
      this.db,
      `INSERT INTO skill_versions (id, agent_id, department_id, path, source_run_id, skill_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId('skillver'), agent.id, agent.departmentId, file, runId, sha256Text(skillText)],
    );
  }

  rollbackSkillVersion({ skillVersionId, reviewerId = 'operator', reason = '' } = {}) {
    const version = get(this.db, 'SELECT * FROM skill_versions WHERE id = ?', [skillVersionId]);
    if (!version) throw new Error(`Skill version not found: ${skillVersionId}`);
    const agent = this.org.agent(version.agent_id);
    if (!agent) throw new Error(`Agent not found for skill rollback: ${version.agent_id}`);
    if (!fs.existsSync(version.path)) throw new Error(`Skill version file is missing: ${version.path}`);
    const previousSkill = readText(agent.skillPath, '');
    const restoredSkill = readText(version.path, '');
    if (!restoredSkill.trim()) throw new Error(`Skill version is empty: ${version.path}`);
    const rollbackRunId = newId('rollback');
    const beforePath = this.snapshotEvolutionFile(agent, rollbackRunId, 'skill-before-rollback', previousSkill);
    writeTextAtomicSync(agent.skillPath, restoredSkill);
    const afterPath = this.snapshotEvolutionFile(agent, rollbackRunId, 'skill-after-rollback', restoredSkill);
    const restoredHash = sha256Text(restoredSkill);
    this.store.recordGovernanceEvent({
      departmentId: agent.departmentId,
      agentId: agent.id,
      eventType: 'skill_rollback',
      status: 'applied',
      confidence: 1,
      rationale: reason || `Restored skill version ${skillVersionId}.`,
      payload: {
        skillVersionId,
        sourceRunId: version.source_run_id,
        previousSkillHash: sha256Text(previousSkill),
        restoredSkillHash: restoredHash,
        beforePath,
        afterPath,
        reviewerId,
      },
    });
    return {
      status: 'applied',
      agentId: agent.id,
      departmentId: agent.departmentId,
      skillVersionId,
      sourceRunId: version.source_run_id,
      restoredSkillHash: restoredHash,
      beforePath,
      afterPath,
    };
  }




}

function parseStructuralActions(proposal) {
  const section = extractMarkdownSection(proposal, 'Structural change decisions');
  const jsonBlock = section.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const decisions = safeJsonParse(jsonBlock ? jsonBlock[1] : section, { actions: [] }) || { actions: [] };
  return Array.isArray(decisions.actions) ? decisions.actions : [];
}

function parseStructuralVoteResponse(raw, actionCount) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1];
  const parsed = safeJsonParse(text, null);
  if (!parsed || !Array.isArray(parsed.votes)) return [];
  return parsed.votes
    .map((item) => ({
      action_index: Number(item?.action_index),
      vote: ['approve', 'reject', 'abstain'].includes(String(item?.vote || '').toLowerCase()) ? String(item.vote).toLowerCase() : 'abstain',
      rationale: clipText(item?.rationale || '', 1000),
    }))
    .filter((item) => Number.isInteger(item.action_index) && item.action_index >= 0 && item.action_index < actionCount);
}

function parseLeadDepartmentVoteResponse(raw) {
  let text = String(raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1];
  const parsed = safeJsonParse(text, null);
  const vote = ['approve', 'reject', 'abstain'].includes(String(parsed?.vote || '').toLowerCase())
    ? String(parsed.vote).toLowerCase()
    : 'abstain';
  return { vote, rationale: clipText(parsed?.rationale || 'No valid highest-lead rationale returned.', 1000) };
}

function restoreStructuralFileManifest(manifest) {
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (!entry.dirExisted && entry.mayBeCreated) {
      fs.rmSync(entry.dir, { recursive: true, force: true });
      continue;
    }
    ensureDirSync(entry.dir);
    for (const file of entry.files || []) {
      if (file.existed) writeTextAtomicSync(file.path, file.content || '');
      else fs.rmSync(file.path, { force: true });
    }
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const result = Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

function parseAgentEvolutionHrReview(raw) {
  const text = String(raw || '').trim();
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  const objectMatch = /\{[\s\S]*\}/.exec(text);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    const parsed = safeJsonParse(candidate, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const decision = normalizeAgentEvolutionHrDecision(parsed.decision || parsed.status || parsed.result);
    if (!decision) continue;
    return {
      decision,
      rationale: clipText(String(parsed.rationale || parsed.reason || ''), 2000),
      requiredRevision: clipText(String(parsed.required_revision || parsed.requiredRevision || parsed.revision || ''), 2000),
      risks: normalizeRiskList(parsed.risks),
    };
  }

  const decision = normalizeAgentEvolutionHrDecision(text);
  if (decision) {
    return {
      decision,
      rationale: clipText(text, 2000),
      requiredRevision: decision === 'partial' ? 'HR marked this proposal partially applicable; submit a revised proposal before applying.' : '',
      risks: [],
    };
  }
  return {
    decision: 'reject',
    rationale: 'HR review output was not valid JSON with a full, partial, or reject decision.',
    requiredRevision: 'Retry HR review with the required JSON schema before applying this proposal.',
    risks: ['malformed_hr_review_output'],
  };
}

function normalizeAgentEvolutionHrDecision(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (/^(full|approve|approved|全部适用|完全适用|通过)$/.test(text)) return 'full';
  if (/^(partial|partially_applicable|partially applicable|revise|needs_revision|部分适用|部分通过|需要修改)$/.test(text)) return 'partial';
  if (/^(reject|rejected|not_applicable|not applicable|deny|denied|不适用|驳回|拒绝)$/.test(text)) return 'reject';
  if (/全部适用|完全适用/.test(text)) return 'full';
  if (/部分适用|需要修改|revise|partial/.test(text)) return 'partial';
  if (/不适用|驳回|reject|denied?/.test(text)) return 'reject';
  return '';
}

function normalizeRiskList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|;|；/)
      .map((item) => item.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  return [];
}

function taskReplayMetrics(task) {
  const nodes = task.nodes || [];
  const communications = task.communications || [];
  const completedNodes = nodes.filter((node) => node.status === 'completed').length;
  const failedNodes = nodes.filter((node) => node.status === 'failed').length;
  const waitingNodes = nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length;
  const outputChars = nodes.reduce((sum, node) => sum + String(node.resultText || '').length, 0);
  const blockingCommunications = communications.filter((item) => item.blocking).length;
  const unresolvedCommunications = communications.filter((item) => item.status === 'open').length;
  const statusScore = task.status === 'completed'
    ? 4
    : task.status === 'failed'
      ? -3
      : task.status === 'waiting'
        ? -1
        : 0;
  const score = Number((
    statusScore +
    completedNodes * 2 -
    failedNodes * 3 -
    waitingNodes -
    blockingCommunications * 0.5 -
    unresolvedCommunications +
    Math.min(2, outputChars / 1000)
  ).toFixed(3));
  return {
    taskRunId: task.id,
    status: task.status,
    score,
    totalNodes: nodes.length,
    completedNodes,
    failedNodes,
    waitingNodes,
    communicationCount: communications.length,
    blockingCommunications,
    unresolvedCommunications,
    outputChars,
  };
}

function memoryMigrationAuditAction(row, action, toState, reason, extra = {}) {
  return {
    action,
    memoryEntryId: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    memoryType: row.memory_type,
    fromState: row.lifecycle_state,
    toState,
    reason,
    ...extra,
  };
}

function appendPatch(current, label, patch, limit) {
  const addition = `\n\n## ${label}\n${patch.trim()}\n`;
  const next = `${current.trimEnd()}${addition}`;
  if (next.length <= limit) return next;
  return `${current.slice(0, Math.max(0, limit - addition.length - 64)).trimEnd()}\n\n<!-- older memory clipped during compact append -->${addition}`;
}


function sanitizeMemoryReplacement(text, agentId) {
  const value = stripFence(text);
  const start = value.indexOf(`# Agent Memory: ${agentId}`);
  return start >= 0 ? value.slice(start).trim() + '\n' : value.trim() + '\n';
}


function applySkillPatch(skill, patch) {
  let next = skill;
  const chunks = [];
  let current = null;
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^Add to \*\*(.+?)\*\*:\s*$/i);
    if (match) {
      if (current) chunks.push(current);
      current = { heading: match[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) chunks.push(current);
  if (!chunks.length) return `${skill.trimEnd()}\n\n${patch.trim()}\n`;
  for (const chunk of chunks) {
    const body = chunk.lines.join('\n').trim();
    if (!body) continue;
    const headingRe = new RegExp(`(^##\\s+${escapeRegExp(chunk.heading)}\\s*$)`, 'im');
    const match = headingRe.exec(next);
    if (!match) {
      next = `${next.trimEnd()}\n\n## ${chunk.heading}\n${body}\n`;
      continue;
    }
    const insertAt = match.index + match[0].length;
    next = `${next.slice(0, insertAt)}\n${body}\n${next.slice(insertAt)}`;
  }
  return next;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function agentCanSelfEvolve(agent) {
  if (!agent || agent.enabled === false || agent.routable === false) return false;
  if (agent.permissions?.canSelfEvolve === false) return false;
  if (['canary', 'shadow', 'paused', 'retired', 'merged', 'disabled', 'rejected'].includes(String(agent.lifecycleStatus || '').toLowerCase())) return false;
  return true;
}

installSpecialistExperimentMethods(EvolutionEngine.prototype, {
  ARCHIVED_PERMISSIONS,
  SPECIALIST_PERMISSIONS,
  get,
  nowIso,
  run,
  safeJsonParse,
  specialistExperimentIncludesBuddy,
  taskReplayMetrics,
});

installGateCalibrationMethods(EvolutionEngine.prototype, {
  DEFAULT_GATE_CALIBRATION,
  REGRESSION_LLM_JUDGE_ENABLED,
  REGRESSION_LLM_TIMEOUT_MS,
  agentMemoryPath,
  agentSkillPath,
  all,
  buildLlmJudgePrompt,
  clipText,
  get,
  newId,
  parseLlmJudgeResult,
  run,
  runCodexExec,
  runRegressionEvalCases,
  runRegressionEvalCasesAsync,
});

const evolutionMethodDependencies = {
  fs,
  path,
  all,
  get,
  run,
  runCodexExec,
  validateCodexAgentToml,
  writeCodexAgentHarness,
  hybridDiagnoseAgentEvidence,
  diagnoseAgentEvidence,
  DEFAULT_GATE_CALIBRATION,
  extractMarkdownSection,
  scoreEvolutionGate,
  validateAgentProposal,
  BUDDY_AGENT_ID,
  BUDDY_DEPARTMENT_ID,
  GENERAL_AGENT_ID,
  labGovernancePolicy,
  applyMemoryPatchToSchema,
  extractTypedMemoryRecords,
  extractTypedMemoryRecordsFromPatch,
  upsertTypedMemory,
  buildAgentEvolutionHrReviewPrompt,
  buildAgentEvolutionRevisionPrompt,
  buildBuddyEvolutionEvaluatorPrompt,
  buildGeneralAgentEvolutionEvaluatorPrompt,
  buildHrReviewPrompt,
  buildIndependentStatementPrompt,
  buildLeadDepartmentApprovalPrompt,
  buildScheduledAgentEvolutionPrompt,
  buildStructuralVotePrompt,
  formatIndependentStatements,
  buildLlmJudgePrompt,
  parseLlmJudgeResult,
  recordRegressionEvalCases,
  runRegressionEvalCases,
  runRegressionEvalCasesAsync,
  agentMemoryPath,
  agentSkillPath,
  evolutionDir,
  hrMemoryPath,
  hrReviewDir,
  skillVersionsDir,
  tmpDir,
  codexEvidenceForAgent,
  clipText,
  ensureDirSync,
  newId,
  nowIso,
  readText,
  safeJsonParse,
  sha256Text,
  writeTextAtomicSync,
  looksNoop,
  normalizeHrMemoryPatch,
  normalizeHrMemoryReplacement,
  stripFence,
  validateHrReviewProposal,
  DEFAULT_MIN_EVIDENCE_MESSAGES,
  DEFAULT_AUTO_APPLY,
  DEFAULT_HR_REVISION_ATTEMPTS,
  DEFAULT_EVOLVE_MAX_WORKERS,
  HR_INDEPENDENT_DEBATE_ENABLED,
  HR_INDEPENDENT_DEBATE_MAX_WORKERS,
  REGRESSION_LLM_JUDGE_ENABLED,
  REGRESSION_LLM_TIMEOUT_MS,
  REGRESSION_AB_REPLAY_ENABLED,
  CANARY_PERMISSIONS,
  SPECIALIST_PERMISSIONS,
  ARCHIVED_PERMISSIONS,
  isBuddyDepartment,
  isBuddyAgent,
  isGeneralAgent,
  specialistExperimentIncludesBuddy,
  structuralActionIncludesBuddy,
  structuralActionTargetsGeneralAgent,
  emitEvolutionProgress,
  progressDetailForError,
  formatRegressionProgressDetail,
  parseStructuralActions,
  parseStructuralVoteResponse,
  parseLeadDepartmentVoteResponse,
  restoreStructuralFileManifest,
  mapWithConcurrency,
  parseAgentEvolutionHrReview,
  normalizeAgentEvolutionHrDecision,
  normalizeRiskList,
  taskReplayMetrics,
  memoryMigrationAuditAction,
  appendPatch,
  sanitizeMemoryReplacement,
  applySkillPatch,
  escapeRegExp,
  agentCanSelfEvolve,
};

installHrReviewMethods(EvolutionEngine.prototype, evolutionMethodDependencies);
installStructuralGovernanceMethods(EvolutionEngine.prototype, evolutionMethodDependencies);
installOrganizationPolicyMethods(EvolutionEngine.prototype, evolutionMethodDependencies);
