export function installOrganizationPolicyMethods(prototype, dependencies) {
  const {
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
  } = dependencies;
  Object.assign(prototype, {
  memoryHealthForAgent(agentId) {
    const rows = all(
      this.db,
      `SELECT memory_type, privacy_level, confidence, status
       FROM typed_memories
       WHERE agent_id = ?`,
      [agentId],
    );
    const active = rows.filter((row) => row.status === 'active');
    return {
      total: rows.length,
      active: active.length,
      blocked_private: rows.filter((row) => row.privacy_level === 'blocked_private').length,
      privacy_policy: rows.filter((row) => row.privacy_level === 'privacy_policy').length,
      forbidden_reuse: rows.filter((row) => row.status === 'blocked' || row.privacy_level === 'privacy_policy').length,
      low_confidence: active.filter((row) => Number(row.confidence || 0) < 0.4).length,
      types: [...new Set(active.map((row) => row.memory_type))],
    };
  },

  recentArchiveSummary(departmentId) {
    const rows = all(
      this.db,
      `SELECT agent_id, gate_status, gate_score, applied, diagnostics_json, created_at
       FROM evolution_archives
       WHERE department_id = ?
       ORDER BY created_at DESC LIMIT 12`,
      [departmentId],
    );
    if (!rows.length) return 'No recent evolution archives.';
    return rows
      .map((row) => {
        const diag = safeJsonParse(row.diagnostics_json, {});
        return `- ${row.created_at} ${row.agent_id}: gate=${row.gate_status}/${row.gate_score}, applied=${Boolean(row.applied)}, layer=${diag.primary_layer || 'unknown'}`;
      })
      .join('\n');
  },

  workflowCreditSummary(departmentId, limit = 12) {
    const rows = all(
      this.db,
      `SELECT agent_id, workflow_step, failure_type, responsibility,
              evidence_summary, recommendation, created_at
       FROM workflow_credit_assignments
       WHERE department_id = ? AND status = 'open'
       ORDER BY responsibility DESC, created_at DESC
       LIMIT ?`,
      [departmentId, limit],
    );
    if (!rows.length) return 'No recent workflow credit assignments.';
    return rows
      .map((row) => `- ${row.agent_id} step=${row.workflow_step} failure=${row.failure_type} responsibility=${Number(row.responsibility || 0).toFixed(2)}: ${row.recommendation || ''} Evidence: ${row.evidence_summary || ''}`)
      .join('\n');
  },

  maturityPolicy(departmentId) {
    const agents = this.org.agentsForDepartment(departmentId, { routableOnly: true });
    const agentCount = agents.length;
    const reviewCount = Number(get(this.db, 'SELECT COUNT(*) AS count FROM hr_reviews WHERE department_id = ?', [departmentId])?.count || 0);
    const evidenceCount = this.departmentMessageCount(agents);
    if (agentCount <= 2 && reviewCount < 3) {
      return { stage: 'bootstrap', agent_count: agentCount, hr_review_count: reviewCount, department_evidence_count: evidenceCount, approval_ratio_required: 0.67, min_evidence_count: DEFAULT_MIN_EVIDENCE_MESSAGES, min_confidence: 0.7, max_structural_actions: 2 };
    }
    if (agentCount <= 5 && reviewCount < 8) {
      return { stage: 'growing', agent_count: agentCount, hr_review_count: reviewCount, department_evidence_count: evidenceCount, approval_ratio_required: 0.8, min_evidence_count: Math.max(12, DEFAULT_MIN_EVIDENCE_MESSAGES * 2), min_confidence: 0.78, max_structural_actions: 1 };
    }
    return { stage: 'mature', agent_count: agentCount, hr_review_count: reviewCount, department_evidence_count: evidenceCount, approval_ratio_required: 0.9, min_evidence_count: Math.max(25, DEFAULT_MIN_EVIDENCE_MESSAGES * 4), min_confidence: 0.85, max_structural_actions: 1 };
  },

  departmentMessageCount(agents) {
    const ids = agents.map((agent) => agent.id).filter(Boolean);
    if (!ids.length) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const row = get(
      this.db,
      `SELECT COUNT(*) AS count
       FROM messages
       WHERE agent_id IN (${placeholders})
         AND role IN ('user', 'assistant')
         AND visible = 1`,
      ids,
    );
    return Number(row?.count || 0);
  },

  validateStructuralDecisions({ departmentId, proposal, maturityPolicy, agents, hr, verifiedVotes = null, leadVotes = null }) {
    const decisions = { actions: parseStructuralActions(proposal) };
    const structuralActionTypes = new Set(['no_change', 'new_agent', 'new_department', 'split_agent', 'merge_agents', 'retire_agent', 'dismiss_agent', 'promote_agent', 'demote_agent', 'probation_agent']);
    const currentAgentIds = new Set(agents.map((agent) => agent.id));
    const requiredVoters = new Set([hr.id, ...currentAgentIds]);
    const organization = this.org.list();
    const existingAgentIds = new Set([...organization.agents, ...organization.hrs, ...(organization.leaders || [])].map((agent) => agent.id));
    const existingDepartmentIds = new Set(organization.departments.map((department) => department.id));
    const highestLeads = this.org.highestLeadAgents();
    const seenNewIds = new Set();
    let approvedCount = 0;
    const errors = [];
    decisions.actions = decisions.actions.map((action, actionIndex) => {
      const itemErrors = [];
      if (!action || typeof action !== 'object' || Array.isArray(action)) {
        return { type: 'invalid', validation_status: 'failed', validation_errors: ['Structural action is not an object.'] };
      }
      if (!structuralActionTypes.has(action.type)) itemErrors.push(`Unsupported structural action type: ${action.type || '(empty)'}.`);
      if (action.type === 'no_change') return { ...action, validation_status: 'approved', validation_errors: [] };
      if (action.status !== 'approved') return { ...action, validation_status: 'rejected_by_hr_status', validation_errors: [] };
      if (approvedCount >= maturityPolicy.max_structural_actions) itemErrors.push('Too many structural actions for maturity stage.');
      const actionRequiredVoters = new Set(requiredVoters);
      if (['new_agent', 'new_department'].includes(action.type)) actionRequiredVoters.add(GENERAL_AGENT_ID);
      const votes = Array.isArray(verifiedVotes)
        ? verifiedVotes
            .filter((vote) => Number(vote.actionIndex) === actionIndex)
            .map((vote) => ({ agent_id: vote.voterAgentId, vote: vote.vote, rationale: vote.rationale, verified: true }))
        : [];
      for (const id of actionRequiredVoters) {
        if (!votes.some((vote) => vote.agent_id === id)) itemErrors.push(`Missing vote: ${id}`);
      }
      const hrVote = votes.find((vote) => vote.agent_id === hr.id);
      if (hrVote?.vote !== 'approve') itemErrors.push('HR must explicitly approve structural action.');
      if (votes.some((vote) => vote.vote === 'reject')) itemErrors.push('Reject vote present.');
      const approveVotes = votes.filter((vote) => vote.vote === 'approve').length;
      const ratio = approveVotes / Math.max(1, actionRequiredVoters.size);
      if (ratio < maturityPolicy.approval_ratio_required) itemErrors.push(`Approval ratio ${ratio.toFixed(2)} below required ${maturityPolicy.approval_ratio_required}.`);
      if (Number(action.evidence_count || 0) < maturityPolicy.min_evidence_count) itemErrors.push('Insufficient action evidence count.');
      const generalOriginEvidenceCount = action.type === 'new_department' && action.origin_agent_id === GENERAL_AGENT_ID
        ? Number(get(this.db, `SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND role IN ('user', 'assistant') AND visible = 1`, [GENERAL_AGENT_ID])?.count || 0)
        : 0;
      if (Number(maturityPolicy.department_evidence_count || 0) < maturityPolicy.min_evidence_count
        && generalOriginEvidenceCount < maturityPolicy.min_evidence_count) itemErrors.push('Insufficient department evidence count and general-Agent evidence count.');
      if (Number(action.confidence || 0) < maturityPolicy.min_confidence) itemErrors.push('Confidence below maturity threshold.');
      if (String(action.evidence_summary || '').trim().length < 24) itemErrors.push('Missing concrete evidence summary.');
      if (String(action.memory_migration_plan || '').trim().length < 24) itemErrors.push('Missing concrete memory migration plan.');
      if (['new_agent', 'new_department'].includes(action.type) && !existingAgentIds.has(GENERAL_AGENT_ID)) {
        itemErrors.push('Standalone Generalist is unavailable for required recruitment participation.');
      }

      const sourceAgents = Array.isArray(action.source_agents) && action.source_agents.every((item) => typeof item === 'string') ? action.source_agents : [];
      const targetAgents = Array.isArray(action.target_agents) && action.target_agents.every((item) => typeof item === 'string') ? action.target_agents : [];
      if (!Array.isArray(action.source_agents) || !action.source_agents.every((item) => typeof item === 'string')) itemErrors.push('source_agents must be a string list.');
      if (!Array.isArray(action.target_agents) || !action.target_agents.every((item) => typeof item === 'string')) itemErrors.push('target_agents must be a string list.');
      for (const source of sourceAgents) {
        if (source === GENERAL_AGENT_ID) itemErrors.push('The standalone Generalist cannot be the target of career, merge, retirement, or dismissal actions.');
        if (!currentAgentIds.has(source)) itemErrors.push(`Unknown source agent: ${source}`);
      }
      for (const target of targetAgents) {
        if (target === GENERAL_AGENT_ID) itemErrors.push('The standalone Generalist cannot be a merge or career-action target.');
      }
      if (['new_agent', 'split_agent'].includes(action.type)) {
        const config = action.new_agent || {};
        if (action.type === 'new_agent' && action.origin_agent_id && action.origin_agent_id !== GENERAL_AGENT_ID && !currentAgentIds.has(action.origin_agent_id)) {
          itemErrors.push(`Unknown new-agent origin agent: ${action.origin_agent_id}`);
        }
        const newId = String(config.id || '').trim();
        if (!/^[a-z][a-z0-9_]{2,63}$/.test(newId)) itemErrors.push('New agent id must be lowercase snake_case and 3-64 chars.');
        if (existingAgentIds.has(newId) || seenNewIds.has(newId)) itemErrors.push(`New agent id already exists: ${newId}`);
        if (newId) seenNewIds.add(newId);
        for (const key of ['name', 'description', 'system_prompt', 'self_evolution_prompt']) {
          if (!String(config[key] || '').trim()) itemErrors.push(`New agent config missing ${key}.`);
        }
        if (!Array.isArray(config.skills) || !config.skills.length || !config.skills.every((item) => typeof item === 'string' && item.trim())) {
          itemErrors.push('New agent skills must be a non-empty string list.');
        }
        if (action.type === 'split_agent' && !sourceAgents.length) itemErrors.push('split_agent requires source_agents.');
      } else if (action.type === 'new_department') {
        const config = action.new_department || {};
        if (action.origin_agent_id && action.origin_agent_id !== GENERAL_AGENT_ID && !currentAgentIds.has(action.origin_agent_id)) {
          itemErrors.push(`Unknown new-department origin agent: ${action.origin_agent_id}`);
        }
        if (action.origin_agent_id === GENERAL_AGENT_ID && !existingAgentIds.has(GENERAL_AGENT_ID)) {
          itemErrors.push('Standalone Generalist is unavailable as the new-department evidence origin.');
        }
        const newDepartmentId = String(config.id || '').trim();
        if (!/^[a-z][a-z0-9_]{2,63}$/.test(newDepartmentId)) itemErrors.push('New department id must be lowercase snake_case and 3-64 chars.');
        if (existingDepartmentIds.has(newDepartmentId)) itemErrors.push(`Department already exists: ${newDepartmentId}`);
        for (const key of ['name', 'description', 'reference_department_id']) {
          if (!String(config[key] || '').trim()) itemErrors.push(`New department config missing ${key}.`);
        }
        if (!existingDepartmentIds.has(config.reference_department_id)) itemErrors.push('reference_department_id must name an existing department.');
        if (!this.org.leaderForDepartment(config.reference_department_id) || !this.org.hrForDepartment(config.reference_department_id)) {
          itemErrors.push('Reference department must have both leader and HR organization structure.');
        }
        const proposedIds = [];
        for (const [roleKey, requiredKeys] of [
          ['leader', ['id', 'name', 'description', 'system_prompt', 'self_evolution_prompt', 'skills']],
          ['hr', ['id', 'name', 'description', 'system_prompt', 'debate_prompt']],
          ['initial_agent', ['id', 'name', 'description', 'system_prompt', 'self_evolution_prompt', 'skills']],
        ]) {
          const role = config[roleKey] || {};
          for (const key of requiredKeys) {
            const valid = key === 'skills'
              ? Array.isArray(role[key]) && role[key].length && role[key].every((item) => typeof item === 'string' && item.trim())
              : Boolean(String(role[key] || '').trim());
            if (!valid) itemErrors.push(`New department ${roleKey} missing valid ${key}.`);
          }
          if (!/^[a-z][a-z0-9_]{2,63}$/.test(String(role.id || ''))) itemErrors.push(`New department ${roleKey} id must be lowercase snake_case.`);
          if (role.id) proposedIds.push(role.id);
        }
        for (const id of proposedIds) {
          if (existingAgentIds.has(id)) itemErrors.push(`New department role id already exists: ${id}`);
          if (proposedIds.filter((item) => item === id).length > 1) itemErrors.push(`Duplicate new department role id: ${id}`);
        }
        const assessment = Array.isArray(config.boundary_assessment) ? config.boundary_assessment : [];
        for (const existingId of existingDepartmentIds) {
          const row = assessment.find((item) => item?.department_id === existingId);
          if (!row) itemErrors.push(`Missing boundary assessment for ${existingId}.`);
          else {
            if (!Number.isFinite(Number(row.overlap_score)) || Number(row.overlap_score) < 0 || Number(row.overlap_score) > 0.35) {
              itemErrors.push(`Capability overlap with ${existingId} is not clearly low (must be 0-0.35).`);
            }
            if (String(row.rationale || '').trim().length < 16) itemErrors.push(`Boundary rationale for ${existingId} is too weak.`);
          }
        }
        if (!highestLeads.length) itemErrors.push('No highest-level lead agents are available to approve a new department.');
        const verifiedLeadVotes = Array.isArray(leadVotes)
          ? leadVotes.filter((vote) => Number(vote.actionIndex) === actionIndex && vote.voterRole === 'highest_lead')
          : [];
        for (const leader of highestLeads) {
          const vote = verifiedLeadVotes.find((item) => item.voterAgentId === leader.id);
          if (!vote) itemErrors.push(`Missing highest-lead approval: ${leader.id}`);
          else if (vote.vote !== 'approve') itemErrors.push(`Highest lead ${leader.id} did not approve.`);
        }
        action.lead_votes = verifiedLeadVotes.map((vote) => ({
          agent_id: vote.voterAgentId,
          vote: vote.vote,
          rationale: vote.rationale,
          verified: true,
        }));
      } else if (action.type === 'merge_agents') {
        if (sourceAgents.length < 1 || targetAgents.length !== 1) itemErrors.push('merge_agents requires source_agents and exactly one target_agent.');
        for (const target of targetAgents) {
          if (!currentAgentIds.has(target)) itemErrors.push(`Unknown target agent: ${target}`);
        }
        if (sourceAgents.some((source) => targetAgents.includes(source))) itemErrors.push('merge_agents cannot merge an agent into itself.');
      } else if (['retire_agent', 'dismiss_agent'].includes(action.type)) {
        if (sourceAgents.length !== 1) itemErrors.push(`${action.type} requires exactly one source_agent.`);
        if (action.type === 'dismiss_agent' && !/(failed|failure|violation|unsafe|考核不通过|违规|严重)/i.test(String(action.evidence_summary || ''))) {
          itemErrors.push('dismiss_agent requires evidence of a failed assessment or serious policy violation.');
        }
      } else if (['promote_agent', 'demote_agent', 'probation_agent'].includes(action.type)) {
        if (sourceAgents.length !== 1) itemErrors.push(`${action.type} requires exactly one source_agent.`);
      }
      const validationStatus = itemErrors.length ? 'failed' : 'approved';
      if (!itemErrors.length) approvedCount += 1;
      errors.push(...itemErrors.map((error) => `${action.type}: ${error}`));
      return { ...action, votes, validation_status: validationStatus, validation_errors: itemErrors };
    });
    return { departmentId, policy: maturityPolicy, decisions, errors };
  }
  });
}
