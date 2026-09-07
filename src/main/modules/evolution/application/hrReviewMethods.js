export function installHrReviewMethods(prototype, dependencies) {
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
  async runHrReview({ departmentId, dryRun = false, autoApply = true, onProgress = null }) {
    const department = this.org.department(departmentId);
    const emitHrProgress = (status, detail = '', extra = {}) => emitEvolutionProgress(onProgress, {
      stage: 'organization',
      status,
      label: '组织校验',
      detail,
      scope: 'department',
      departmentId,
      ...extra,
    });
    if (isBuddyDepartment(departmentId)) {
      emitHrProgress('skipped', 'Buddy agent 不参与实验室级招募、开除、晋升或组织结构调整。');
      return { departmentId, status: 'skipped', reason: 'buddy_agent_lab_governance_excluded' };
    }
    emitHrProgress('running', `${department?.name || departmentId}：HR 正在汇总独立意见和结构建议。`);
    const hr = this.org.hrForDepartment(departmentId);
    const agents = this.org.agentsForDepartment(departmentId, { routableOnly: true });
    const generalAgent = this.org.agent(GENERAL_AGENT_ID);
    if (!department || !hr) {
      emitHrProgress('skipped', '缺少部门或 HR agent。');
      return { departmentId, status: 'skipped', reason: 'missing department or HR' };
    }
    const reviewId = newId('hr');
    run(
      this.db,
      `INSERT INTO hr_reviews (id, department_id, status)
       VALUES (?, ?, 'running')`,
      [reviewId, departmentId],
    );
    const reviewDir = hrReviewDir(this.root, departmentId);
    ensureDirSync(reviewDir);
    const proposalPath = path.join(reviewDir, `${reviewId}.md`);
    try {
      const maturityPolicy = this.maturityPolicy(departmentId);
      this.recordDepartmentPerformanceReviews({ departmentId, agents, sourceReviewId: reviewId });
      const workflowCredit = this.workflowCreditSummary(departmentId);
      const generalEvidenceRows = generalAgent ? codexEvidenceForAgent({
        db: this.db,
        store: this.store,
        root: this.root,
        agentId: GENERAL_AGENT_ID,
        limit: 20,
      }) : [];
      const generalAgentEvidence = generalEvidenceRows.length
        ? generalEvidenceRows.map((item, index) => `${index + 1}. ${String(item.role || '').toUpperCase()}: ${clipText(item.content || '', 500)}`).join('\n')
        : '';
      const labRecruitmentMemory = this.labRecruitmentMemoryDigest();
      const roster = agents.map((agent) => `- ${agent.id}: ${agent.description}`).join('\n');
      const governanceParticipants = [hr, ...agents];
      const statementParticipants = HR_INDEPENDENT_DEBATE_ENABLED
        ? (generalAgent ? [...governanceParticipants, generalAgent] : governanceParticipants)
        : (generalAgent ? [generalAgent] : []);
      const statements = await mapWithConcurrency(statementParticipants, HR_INDEPENDENT_DEBATE_MAX_WORKERS, async (participant) => {
        try {
          const isGeneralRecruitmentParticipant = participant.id === GENERAL_AGENT_ID;
          const dossier = participant.role === 'hr'
            ? readText(hr.memoryPath, '')
            : isGeneralRecruitmentParticipant
              ? labRecruitmentMemory.digest
            : `${readText(participant.skillPath, '')}\n\n${readText(participant.memoryPath, '')}`;
          const statement = await runCodexExec({
            prompt: buildIndependentStatementPrompt({
              department,
              participant,
              roster,
              maturityPolicy,
              dossier,
              workflowCredit,
              participationScope: isGeneralRecruitmentParticipant ? 'recruitment_only' : 'full_department_governance',
            }),
            agentId: participant.id,
            role: 'hr-debate',
            root: this.root,
            sandbox: 'read-only',
            dryRun,
            executionContext: this.modelExecutionContext(participant, 'hr_independent_statement', { metadata: { reviewId } }),
          });
          return { participantId: participant.id, statement };
        } catch (error) {
          return { participantId: participant.id, error: String(error.message || error) };
        }
      });
      const proposal = await runCodexExec({
        prompt: buildHrReviewPrompt({
          department,
          hr,
          agents,
          organizationDepartments: this.org.list().departments,
          generalAgentEvidence,
          labRecruitmentMemory: labRecruitmentMemory.digest,
          hrMemory: readText(hr.memoryPath, ''),
          statements: formatIndependentStatements(statements),
          recentProposals: this.recentArchiveSummary(departmentId),
          workflowCredit,
          maturityPolicy,
        }),
        agentId: hr.id,
        role: 'hr',
        root: this.root,
        sandbox: 'read-only',
        dryRun,
        executionContext: this.modelExecutionContext(hr, 'hr_review_proposal', { metadata: { reviewId } }),
      });
      writeTextAtomicSync(proposalPath, proposal);
      const validationErrors = validateHrReviewProposal(proposal);
      const proposedActions = parseStructuralActions(proposal);
      const departmentVotes = await this.collectIndependentStructuralVotes({
        reviewId,
        department,
        participants: governanceParticipants,
        actions: proposedActions,
        dryRun,
      });
      const generalRecruitmentVotes = generalAgent
        ? await this.collectIndependentStructuralVotes({
            reviewId,
            department,
            participants: [generalAgent],
            actions: proposedActions,
            allowedActionTypes: ['new_agent', 'new_department'],
            participationScope: 'recruitment_only',
            dryRun,
          })
        : [];
      const verifiedVotes = [...departmentVotes, ...generalRecruitmentVotes];
      const leadVotes = await this.collectLeadCouncilVotes({
        reviewId,
        actions: proposedActions,
        dryRun,
      });
      const structural = this.validateStructuralDecisions({ departmentId, proposal, maturityPolicy, agents, hr, verifiedVotes, leadVotes });
      const governanceErrors = [...validationErrors, ...(structural.errors || [])];
      const status = governanceErrors.length ? 'failed' : 'proposed';
      run(
        this.db,
        `UPDATE hr_reviews
         SET status = ?, proposal_path = ?, summary = ?, structural_json = ?, gate_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
        [
          status,
          proposalPath,
          status === 'failed' ? `HR validation failed: ${governanceErrors.join('; ')}` : 'HR review proposal created.',
          JSON.stringify(structural),
          JSON.stringify({ validationErrors, structuralErrors: structural.errors || [] }),
          nowIso(),
          nowIso(),
          reviewId,
        ],
      );
      if (status === 'proposed' && autoApply) {
        this.applyHrReview({ departmentId, reviewId, proposal, structural });
        emitHrProgress('success', `${department.name || departmentId}：HR review 已应用。`, { reviewId, reviewStatus: 'applied' });
        return { departmentId, reviewId, status: 'applied', proposalPath, structural };
      }
      emitHrProgress(status === 'failed' ? 'failed' : 'success', status === 'failed' ? `HR validation failed: ${governanceErrors.join('; ')}` : `${department.name || departmentId}：HR review 已生成。`, { reviewId, reviewStatus: status });
      return { departmentId, reviewId, status, proposalPath, validationErrors: governanceErrors, structural };
    } catch (error) {
      run(
        this.db,
        `UPDATE hr_reviews SET status = 'failed', proposal_path = ?, summary = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
        [proposalPath, String(error.message || error), nowIso(), nowIso(), reviewId],
      );
      emitHrProgress('failed', progressDetailForError(error), { reviewId });
      return { departmentId, reviewId, status: 'failed', error: String(error.message || error), proposalPath };
    }
  },

  async collectIndependentStructuralVotes({
    reviewId,
    department,
    participants,
    actions,
    allowedActionTypes = null,
    participationScope = 'full_department_governance',
    dryRun = false,
  }) {
    if (!actions.some((action) => action.type && action.type !== 'no_change')) return [];
    const actionEntries = actions
      .map((action, actionIndex) => ({ action, actionIndex }))
      .filter(({ action }) => !Array.isArray(allowedActionTypes) || allowedActionTypes.includes(action.type));
    if (!actionEntries.length) return [];
    const voteActions = actionEntries.map(({ action }) => {
      const { votes: _untrustedVotes, ...cleanAction } = action;
      return cleanAction;
    });
    const votes = [];
    for (const participant of participants) {
      let raw = '';
      try {
        raw = dryRun
          ? JSON.stringify({ votes: voteActions.map((_, actionIndex) => ({ action_index: actionIndex, vote: 'approve', rationale: 'dry-run verified vote' })) })
          : await runCodexExec({
              prompt: buildStructuralVotePrompt({ department, participant, actions: voteActions, participationScope }),
              agentId: participant.id,
              role: 'hr-structural-vote',
              root: this.root,
              sandbox: 'read-only',
              executionContext: this.modelExecutionContext(participant, 'hr_structural_vote', { metadata: { reviewId } }),
            });
      } catch (error) {
        raw = JSON.stringify({ votes: [], error: String(error.message || error) });
      }
      const parsed = parseStructuralVoteResponse(raw, actionEntries.length);
      for (let scopedIndex = 0; scopedIndex < actionEntries.length; scopedIndex += 1) {
        const actionIndex = actionEntries[scopedIndex].actionIndex;
        const item = parsed.find((vote) => vote.action_index === scopedIndex) || { vote: 'abstain', rationale: 'No valid independent vote returned.' };
        const row = {
          reviewId,
          departmentId: department.id,
          actionIndex,
          actionType: actions[actionIndex]?.type || '',
          voterAgentId: participant.id,
          vote: item.vote,
          rationale: item.rationale,
          responseHash: sha256Text(raw),
        };
        run(
          this.db,
          `INSERT INTO hr_governance_votes (
            id, review_id, department_id, action_index, action_type, voter_agent_id,
            vote, rationale, response_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId('hrvote'), reviewId, department.id, actionIndex, row.actionType, participant.id, row.vote, row.rationale, row.responseHash],
        );
        votes.push(row);
      }
    }
    return votes;
  },

  async collectLeadCouncilVotes({ reviewId, actions, dryRun = false }) {
    if (!actions.some((action) => action.type === 'new_department')) return [];
    const leaders = this.org.highestLeadAgents();
    const departments = this.org.list().departments;
    const votes = [];
    for (const leader of leaders) {
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
        const action = actions[actionIndex];
        if (action?.type !== 'new_department') continue;
        let raw = '';
        try {
          raw = dryRun
            ? JSON.stringify({ vote: 'approve', rationale: 'dry-run highest-lead approval' })
            : await runCodexExec({
                prompt: buildLeadDepartmentApprovalPrompt({ leader, departments, action }),
                agentId: leader.id,
                role: 'lead-department-approval',
                root: this.root,
                sandbox: 'read-only',
                executionContext: this.modelExecutionContext(leader, 'lead_department_approval', { metadata: { reviewId } }),
              });
        } catch (error) {
          raw = JSON.stringify({ vote: 'abstain', rationale: String(error.message || error) });
        }
        const parsed = parseLeadDepartmentVoteResponse(raw);
        const row = {
          reviewId,
          departmentId: String(action.new_department?.id || ''),
          actionIndex,
          actionType: action.type,
          voterAgentId: leader.id,
          vote: parsed.vote,
          rationale: parsed.rationale,
          responseHash: sha256Text(raw),
          voterRole: 'highest_lead',
        };
        run(
          this.db,
          `INSERT INTO hr_governance_votes (
            id, review_id, department_id, action_index, action_type, voter_agent_id,
            vote, rationale, response_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId('leadvote'), reviewId, row.departmentId, actionIndex, row.actionType, leader.id, row.vote, row.rationale, row.responseHash],
        );
        votes.push(row);
      }
    }
    return votes;
  }
  });
}
