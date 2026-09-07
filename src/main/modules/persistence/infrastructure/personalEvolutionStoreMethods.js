import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse, sha256Text } from '../../../utils.js';

export function installPersonalEvolutionStoreMethods(prototype) {
  Object.assign(prototype, {
    createPersonalEvolutionProposal(input = {}) {
      const id = input.id || newId('peproposal');
      const now = nowIso();
      run(this.db, `INSERT INTO personal_evolution_proposals (
        id, run_id, user_id, user_agent_instance_id, agent_family_id, status,
        sync_scope, origin_device_id, base_agent_version_id, base_personal_skill_version_id,
        base_effective_skill_hash, base_memory_manifest_hash, evidence_cursor_from,
        evidence_cursor_to, evidence_count, distinct_context_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, input.runId, input.userId, input.agentInstanceId, input.agentFamilyId,
        input.status || 'running', input.syncScope || 'local_only', input.originDeviceId || '',
        input.baseAgentVersionId || '', input.basePersonalSkillVersionId || '',
        input.baseEffectiveSkillHash || '', input.baseMemoryManifestHash || '',
        stringify(input.evidenceCursorFrom || {}), stringify(input.evidenceCursorTo || {}),
        Number(input.evidenceCount || 0), Number(input.distinctContextCount || 0), now, now,
      ]);
      return this.getPersonalEvolutionProposal(id);
    },

    updatePersonalEvolutionProposal(proposalId, patch = {}) {
      const mapping = {
        status: 'status', decision: 'decision', skillActionStatus: 'skill_action_status',
        memoryActionStatus: 'memory_action_status', evidenceCursorTo: 'evidence_cursor_to',
        candidatePersonalSkillVersionId: 'candidate_personal_skill_version_id',
        evidenceCount: 'evidence_count', distinctContextCount: 'distinct_context_count',
        proposalMarkdown: 'proposal_markdown', proposalHash: 'proposal_hash', summary: 'summary',
        proposedOverlayText: 'proposed_overlay_text', proposedOverlayHash: 'proposed_overlay_hash',
        diagnostics: 'diagnostics_json', gate: 'gate_json', privacyReport: 'privacy_report_json',
        evaluationSummary: 'evaluation_summary_json', autoActivationEligible: 'auto_activation_eligible',
        expiresReason: 'expires_reason', expiresAt: 'expires_at', decidedAt: 'decided_at',
      };
      const jsonFields = new Set(['evidenceCursorTo', 'diagnostics', 'gate', 'privacyReport', 'evaluationSummary']);
      const booleanFields = new Set(['autoActivationEligible']);
      const fields = [];
      const params = [];
      for (const [key, column] of Object.entries(mapping)) {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
        fields.push(`${column} = ?`);
        const value = jsonFields.has(key) ? stringify(patch[key]) : booleanFields.has(key) ? (patch[key] ? 1 : 0) : patch[key];
        params.push(value ?? '');
      }
      if (!fields.length) return this.getPersonalEvolutionProposal(proposalId);
      fields.push('updated_at = ?');
      params.push(nowIso(), proposalId);
      run(this.db, `UPDATE personal_evolution_proposals SET ${fields.join(', ')} WHERE id = ?`, params);
      return this.getPersonalEvolutionProposal(proposalId);
    },

    getPersonalEvolutionProposal(proposalId) {
      const proposal = normalizeProposal(get(this.db, 'SELECT * FROM personal_evolution_proposals WHERE id = ?', [proposalId]));
      if (!proposal) return null;
      proposal.evidence = all(this.db, 'SELECT * FROM personal_evolution_proposal_evidence WHERE proposal_id = ? ORDER BY occurred_at, id', [proposalId]).map(normalizeEvidence);
      proposal.memoryOperations = all(this.db, 'SELECT * FROM personal_evolution_memory_operations WHERE proposal_id = ? ORDER BY created_at, id', [proposalId]).map(normalizeMemoryOperation);
      proposal.evaluations = all(this.db, 'SELECT * FROM personal_evolution_evaluations WHERE proposal_id = ? ORDER BY case_index', [proposalId]).map(normalizeEvaluation);
      proposal.actions = all(this.db, 'SELECT * FROM personal_evolution_proposal_actions WHERE proposal_id = ? ORDER BY created_at, id', [proposalId]).map(normalizeAction);
      return proposal;
    },

    listPersonalEvolutionProposals({ userId = '', agentInstanceId = '', status = '', limit = 100 } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (userId) { where.push('user_id = ?'); params.push(userId); }
      if (agentInstanceId) { where.push('user_agent_instance_id = ?'); params.push(agentInstanceId); }
      if (status) { where.push('status = ?'); params.push(status); }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM personal_evolution_proposals WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, params).map(normalizeProposal);
    },

    addPersonalEvolutionEvidence(proposalId, items = []) {
      for (const item of items) {
        run(this.db, `INSERT OR IGNORE INTO personal_evolution_proposal_evidence (
          id, proposal_id, source_kind, source_id, source_hash, occurred_at,
          context_key, privacy_level, included, rejection_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          item.id || newId('peev'), proposalId, item.sourceKind, item.sourceId,
          item.sourceHash || sha256Text(item.content || ''), item.occurredAt || '',
          item.contextKey || '', item.privacyLevel || 'private', item.included === false ? 0 : 1,
          item.rejectionReason || '',
        ]);
      }
      return this.getPersonalEvolutionProposal(proposalId)?.evidence || [];
    },

    addPersonalEvolutionMemoryOperations(proposalId, operations = []) {
      for (const item of operations) {
        run(this.db, `INSERT INTO personal_evolution_memory_operations (
          id, proposal_id, memory_document_id, section_name, operation_type,
          target_item_hash, proposed_text, rationale, baseline_version_id,
          baseline_content_hash, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          item.id || newId('pememop'), proposalId, item.memoryDocumentId, item.sectionName,
          item.operationType, item.targetItemHash || '', item.proposedText || '', item.rationale || '',
          item.baselineVersionId || '', item.baselineContentHash || '', item.status || 'pending',
        ]);
      }
      return this.getPersonalEvolutionProposal(proposalId)?.memoryOperations || [];
    },

    addPersonalEvolutionEvaluations(proposalId, evaluations = []) {
      for (const [index, item] of evaluations.entries()) {
        run(this.db, `INSERT INTO personal_evolution_evaluations (
          id, proposal_id, case_index, input_text, expected_text, baseline_output,
          candidate_output, baseline_score, candidate_score, regression, judge_json,
          status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposal_id, case_index) DO UPDATE SET
          input_text = excluded.input_text, expected_text = excluded.expected_text,
          baseline_output = excluded.baseline_output, candidate_output = excluded.candidate_output,
          baseline_score = excluded.baseline_score, candidate_score = excluded.candidate_score,
          regression = excluded.regression, judge_json = excluded.judge_json,
          status = excluded.status, updated_at = excluded.updated_at`, [
          item.id || newId('peeval'), proposalId, Number(item.caseIndex ?? index),
          item.inputText || '', item.expectedText || '', item.baselineOutput || '',
          item.candidateOutput || '', Number(item.baselineScore || 0), Number(item.candidateScore || 0),
          item.regression ? 1 : 0, stringify(item.judge || {}), item.status || 'completed', nowIso(),
        ]);
      }
      return this.getPersonalEvolutionProposal(proposalId)?.evaluations || [];
    },

    recordPersonalEvolutionAction(input = {}) {
      const id = input.id || newId('peaction');
      run(this.db, `INSERT INTO personal_evolution_proposal_actions (
        id, proposal_id, target_kind, target_id, decision, actor_user_id,
        actor_device_id, revision, sync_status, error_text, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, input.proposalId, input.targetKind, input.targetId || '', input.decision,
        input.actorUserId || '', input.actorDeviceId || '', Number(input.revision || 0),
        input.syncStatus || 'local', input.errorText || '', input.confirmedAt || '',
      ]);
      return normalizeAction(get(this.db, 'SELECT * FROM personal_evolution_proposal_actions WHERE id = ?', [id]));
    },

    getPersonalEvolutionInstanceState(agentInstanceId) {
      return normalizeInstanceState(get(this.db, 'SELECT * FROM personal_evolution_instance_state WHERE user_agent_instance_id = ?', [agentInstanceId])) || {
        agentInstanceId, evidenceCursor: {}, lastRunAt: '', lastReadyAt: '', nextEligibleAt: '', runningRunId: '', lastError: '', updatedAt: '',
      };
    },

    updatePersonalEvolutionInstanceState(agentInstanceId, patch = {}) {
      const current = this.getPersonalEvolutionInstanceState(agentInstanceId);
      const next = { ...current, ...patch, agentInstanceId, updatedAt: nowIso() };
      run(this.db, `INSERT INTO personal_evolution_instance_state (
        user_agent_instance_id, evidence_cursor_json, last_run_at, last_ready_at,
        next_eligible_at, running_run_id, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_agent_instance_id) DO UPDATE SET
        evidence_cursor_json = excluded.evidence_cursor_json, last_run_at = excluded.last_run_at,
        last_ready_at = excluded.last_ready_at, next_eligible_at = excluded.next_eligible_at,
        running_run_id = excluded.running_run_id, last_error = excluded.last_error,
        updated_at = excluded.updated_at`, [
        agentInstanceId, stringify(next.evidenceCursor || {}), next.lastRunAt || '', next.lastReadyAt || '',
        next.nextEligibleAt || '', next.runningRunId || '', next.lastError || '', next.updatedAt,
      ]);
      return this.getPersonalEvolutionInstanceState(agentInstanceId);
    },
  });
}

function normalizeProposal(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, userId: row.user_id, agentInstanceId: row.user_agent_instance_id,
    agentFamilyId: row.agent_family_id, status: row.status, decision: row.decision,
    skillActionStatus: row.skill_action_status, memoryActionStatus: row.memory_action_status,
    syncScope: row.sync_scope, originDeviceId: row.origin_device_id,
    baseAgentVersionId: row.base_agent_version_id, basePersonalSkillVersionId: row.base_personal_skill_version_id,
    candidatePersonalSkillVersionId: row.candidate_personal_skill_version_id || '',
    baseEffectiveSkillHash: row.base_effective_skill_hash, baseMemoryManifestHash: row.base_memory_manifest_hash,
    evidenceCursorFrom: safeJsonParse(row.evidence_cursor_from, {}), evidenceCursorTo: safeJsonParse(row.evidence_cursor_to, {}),
    evidenceCount: Number(row.evidence_count || 0), distinctContextCount: Number(row.distinct_context_count || 0),
    proposalMarkdown: row.proposal_markdown || '', proposalHash: row.proposal_hash || '', summary: row.summary || '',
    proposedOverlayText: row.proposed_overlay_text || '', proposedOverlayHash: row.proposed_overlay_hash || '',
    diagnostics: safeJsonParse(row.diagnostics_json, {}), gate: safeJsonParse(row.gate_json, {}),
    privacyReport: safeJsonParse(row.privacy_report_json, {}), evaluationSummary: safeJsonParse(row.evaluation_summary_json, {}),
    autoActivationEligible: Boolean(row.auto_activation_eligible), expiresReason: row.expires_reason || '',
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at || '', decidedAt: row.decided_at || '',
  };
}

function normalizeEvidence(row) { return row ? { id: row.id, proposalId: row.proposal_id, sourceKind: row.source_kind, sourceId: row.source_id, sourceHash: row.source_hash, occurredAt: row.occurred_at, contextKey: row.context_key, privacyLevel: row.privacy_level, included: Boolean(row.included), rejectionReason: row.rejection_reason, createdAt: row.created_at } : null; }
function normalizeMemoryOperation(row) { return row ? { id: row.id, proposalId: row.proposal_id, memoryDocumentId: row.memory_document_id, sectionName: row.section_name, operationType: row.operation_type, targetItemHash: row.target_item_hash, proposedText: row.proposed_text, rationale: row.rationale, baselineVersionId: row.baseline_version_id, baselineContentHash: row.baseline_content_hash, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function normalizeEvaluation(row) { return row ? { id: row.id, proposalId: row.proposal_id, caseIndex: Number(row.case_index || 0), inputText: row.input_text, expectedText: row.expected_text, baselineOutput: row.baseline_output, candidateOutput: row.candidate_output, baselineScore: Number(row.baseline_score || 0), candidateScore: Number(row.candidate_score || 0), regression: Boolean(row.regression), judge: safeJsonParse(row.judge_json, {}), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
function normalizeAction(row) { return row ? { id: row.id, proposalId: row.proposal_id, targetKind: row.target_kind, targetId: row.target_id, decision: row.decision, actorUserId: row.actor_user_id, actorDeviceId: row.actor_device_id, revision: Number(row.revision || 0), syncStatus: row.sync_status, errorText: row.error_text, createdAt: row.created_at, confirmedAt: row.confirmed_at } : null; }
function normalizeInstanceState(row) { return row ? { agentInstanceId: row.user_agent_instance_id, evidenceCursor: safeJsonParse(row.evidence_cursor_json, {}), lastRunAt: row.last_run_at, lastReadyAt: row.last_ready_at, nextEligibleAt: row.next_eligible_at, runningRunId: row.running_run_id, lastError: row.last_error, updatedAt: row.updated_at } : null; }
function stringify(value) { return JSON.stringify(value ?? {}); }
