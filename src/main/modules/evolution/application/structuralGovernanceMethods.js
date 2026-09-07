export function installStructuralGovernanceMethods(prototype, dependencies) {
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
  applyHrReview({ departmentId, reviewId, proposal, structural }) {
    const memoryPath = hrMemoryPath(this.root, departmentId);
    const before = readText(memoryPath, '');
    const replacement = normalizeHrMemoryReplacement(extractMarkdownSection(proposal, 'HR memory replacement'));
    const patch = normalizeHrMemoryPatch(extractMarkdownSection(proposal, 'HR memory patch'));
    let next = before;
    if (!looksNoop(replacement)) {
      next = replacement.trim() + '\n';
    } else if (!looksNoop(patch)) {
      next = patch.startsWith('# HR Memory:')
        ? patch.trim() + '\n'
        : appendPatch(before, `HR Review ${reviewId}`, patch, 25 * 1024);
    }
    const memorySnapshotPath = path.join(hrReviewDir(this.root, departmentId), `${reviewId}-memory-before.md`);
    writeTextAtomicSync(memorySnapshotPath, before);
    const rollbackManifest = this.structuralFileRollbackManifest(departmentId, structural);
    const journalId = newId('hrapplyjournal');
    run(
      this.db,
      `INSERT INTO hr_apply_journal (
        id, review_id, department_id, status, hr_memory_path, hr_memory_snapshot_path,
        rollback_manifest_json, structural_json
      ) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?)`,
      [journalId, reviewId, departmentId, memoryPath, memorySnapshotPath, JSON.stringify(rollbackManifest), JSON.stringify(structural || {})],
    );
    run(this.db, `UPDATE hr_apply_journal SET status = 'committing', updated_at = ? WHERE id = ?`, [nowIso(), journalId]);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      writeTextAtomicSync(memoryPath, next);
      this.applyStructuralActions(departmentId, structural, reviewId);
      this.validateRegeneratedCodexHarness(reviewId);
      this.recordStructuralGovernanceEvents({ departmentId, reviewId, structural });
      run(
        this.db,
        `UPDATE hr_reviews SET status = 'applied', updated_at = ?, completed_at = ? WHERE id = ?`,
        [nowIso(), nowIso(), reviewId],
      );
      run(this.db, `UPDATE hr_apply_journal SET status = 'committed', updated_at = ?, completed_at = ? WHERE id = ?`, [nowIso(), nowIso(), journalId]);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      writeTextAtomicSync(memoryPath, before);
      restoreStructuralFileManifest(rollbackManifest);
      run(
        this.db,
        `UPDATE hr_apply_journal SET status = 'rolled_back', error_text = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
        [clipText(error.message || String(error), 2000), nowIso(), nowIso(), journalId],
      );
      throw error;
    }
  },

  validateRegeneratedCodexHarness(reviewId = '') {
    const harnessHome = path.join(tmpDir(this.root), 'evolution-harness-validation', reviewId || newId('review'));
    fs.rmSync(harnessHome, { recursive: true, force: true });
    try {
      const definitions = writeCodexAgentHarness(this.root, harnessHome);
      for (const definition of definitions) {
        const tomlPath = path.join(harnessHome, 'agents', `${definition.id}.toml`);
        validateCodexAgentToml(readText(tomlPath, ''));
      }
      return { status: 'passed', agentCount: definitions.length };
    } finally {
      fs.rmSync(harnessHome, { recursive: true, force: true });
    }
  },

  structuralFileRollbackManifest(departmentId, structural) {
    const entries = [];
    const seen = new Set();
    const capture = (agentId, mayBeCreated = false) => {
      if (!agentId || seen.has(agentId)) return;
      seen.add(agentId);
      const dir = path.join(this.root, 'departments', departmentId, 'agents', agentId);
      const dirExisted = fs.existsSync(dir);
      entries.push({
        agentId,
        dir,
        dirExisted,
        mayBeCreated,
        files: ['agent.json', 'lifecycle.json', 'SKILL.md', 'MEMORY.md'].map((name) => {
          const filePath = path.join(dir, name);
          return { path: filePath, existed: fs.existsSync(filePath), content: readText(filePath, '') };
        }),
      });
    };
    for (const action of structural?.decisions?.actions || []) {
      if (action.validation_status !== 'approved') continue;
      if (action.type === 'new_department' && action.new_department?.id) {
        const dir = path.join(this.root, 'departments', action.new_department.id);
        entries.push({
          departmentId: action.new_department.id,
          dir,
          dirExisted: fs.existsSync(dir),
          mayBeCreated: true,
          files: [],
        });
      }
      if (['new_agent', 'split_agent'].includes(action.type)) capture(action.new_agent?.id, true);
      for (const agentId of action.source_agents || []) capture(agentId, false);
    }
    return entries;
  },

  applyStructuralActions(departmentId, structural, reviewId = '') {
    const actions = structural?.decisions?.actions || [];
    for (const action of actions) {
      if (action.type === 'no_change' || action.validation_status !== 'approved') continue;
      if (structuralActionIncludesBuddy(departmentId, action)) {
        this.store.recordGovernanceEvent({
          departmentId,
          agentId: BUDDY_AGENT_ID,
          eventType: 'buddy_lab_action_blocked',
          status: 'rejected_by_policy',
          rationale: 'Buddy agent is excluded from recruitment, promotion, demotion, probation, merge, retirement, dismissal, and specialist experiments.',
          payload: action,
          sourceReviewId: reviewId,
        });
        continue;
      }
      if (structuralActionTargetsGeneralAgent(action)) {
        this.store.recordGovernanceEvent({
          departmentId,
          agentId: GENERAL_AGENT_ID,
          eventType: 'general_agent_lab_action_blocked',
          status: 'rejected_by_policy',
          rationale: 'The standalone Generalist may deliberate on recruitment but cannot be recruited, assessed, promoted, demoted, placed on probation, merged, retired, dismissed, or otherwise targeted by Lab career actions.',
          payload: action,
          sourceReviewId: reviewId,
        });
        continue;
      }
      if (action.type === 'new_department') {
        this.createNewDepartment(action, reviewId);
        continue;
      }
      if (action.type === 'new_agent' || action.type === 'split_agent') {
        const config = action.new_agent || {};
        if (!config.id) continue;
        const assessment = this.assessStructuralAgentAdmission({ departmentId, config, action, reviewId });
        if (!assessment.passed) throw new Error(`New agent ${config.id} failed immediate admission assessment (score ${assessment.score}).`);
        const dir = path.join(this.root, 'departments', departmentId, 'agents', config.id);
        const sourceAgents = Array.isArray(action.source_agents) ? action.source_agents : [];
        const baselineAgentId = sourceAgents[0] || '';
        ensureDirSync(dir);
        writeTextAtomicSync(path.join(dir, 'agent.json'), JSON.stringify({
          id: config.id,
          name: config.name || config.id,
          description: config.description || '',
          skills: Array.isArray(config.skills) ? config.skills : [],
          system_prompt: config.system_prompt || '',
          self_evolution_prompt: config.self_evolution_prompt || '',
          enabled: true,
          evolution: { interval_hours: 24, min_messages: DEFAULT_MIN_EVIDENCE_MESSAGES },
          lifecycle: {
            status: 'active',
            routing_state: 'active',
            role: 'specialist',
            automatic_routing: true,
            permissions: SPECIALIST_PERMISSIONS,
            created_by: 'hr_structural_review',
            started_by_review_id: reviewId,
            baseline_agent_id: baselineAgentId,
            source_agents: sourceAgents,
            immediate_admission_assessment: assessment,
          },
          created_by_hr_review: reviewId,
          created_from_action: action.type,
          source_agents: sourceAgents,
        }, null, 2));
        writeTextAtomicSync(path.join(dir, 'lifecycle.json'), JSON.stringify({
          status: 'active',
          routing_state: 'active',
          role: 'specialist',
          automatic_routing: true,
          permissions: SPECIALIST_PERMISSIONS,
          started_by_review_id: reviewId,
          baseline_agent_id: baselineAgentId,
          source_agents: sourceAgents,
          immediate_admission_assessment: assessment,
          created_at: nowIso(),
        }, null, 2));
        writeTextAtomicSync(path.join(dir, 'SKILL.md'), `---\nname: ${config.id}\ndescription: ${config.description || ''}\n---\n\n# ${config.name || config.id}\n\n## Mission\n${config.description || ''}\n\n## Core Workflow\n- Operate as an active specialist after passing immediate admission assessment.\n`);
        writeTextAtomicSync(path.join(dir, 'MEMORY.md'), `# Agent Memory: ${config.id}\n## Stable Learnings\n- None yet.\n## Reusable Preferences\n- None yet.\n## Failure Modes\n- None yet.\n## Workflow Notes\n- Passed immediate admission assessment in review ${reviewId}.\n## Topic Files\n- None yet.\n## Do Not Store\n- Private user content, secrets, unpublished data, and one-off task facts.\n`);
        run(
          this.db,
          `INSERT INTO specialist_experiments (
            id, department_id, candidate_agent_id, source_agent_id, status,
            baseline_agent_id, started_by_review_id, state, metrics_json,
            decision_notes, evaluation_json
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, 'promoted', ?, ?, ?)`,
          [
            newId('experiment'),
            departmentId,
            config.id,
            baselineAgentId,
            baselineAgentId,
            reviewId,
            JSON.stringify({ manual_runs: 0, auto_routed_runs: 0 }),
            'Created by HR structural review and activated immediately after passing admission assessment.',
            JSON.stringify({
              source_review_id: reviewId,
              evidence_summary: action.evidence_summary || '',
              memory_migration_plan: action.memory_migration_plan || '',
              immediate_admission_assessment: assessment,
            }),
          ],
        );
      }
      if (['promote_agent', 'demote_agent', 'probation_agent'].includes(action.type)) {
        const agentId = Array.isArray(action.source_agents) ? action.source_agents[0] : '';
        if (agentId) {
          this.transitionAgentCareer({
            agentId,
            action: action.type === 'promote_agent' ? 'promote' : action.type === 'demote_agent' ? 'demote' : 'probation',
            reviewerId: reviewId || 'hr_structural_review',
            reason: action.evidence_summary || '',
          });
        }
      }
      if (['merge_agents', 'retire_agent', 'dismiss_agent'].includes(action.type)) {
        for (const source of action.source_agents || []) {
          const dir = path.join(this.root, 'departments', departmentId, 'agents', source);
          if (fs.existsSync(dir)) {
            const status = ['retire_agent', 'dismiss_agent'].includes(action.type) ? 'retired' : 'merged';
            const targetAgentId = action.type === 'merge_agents' ? (action.target_agents || [])[0] || '' : '';
            this.migrateStructuralMemory({
              departmentId,
              sourceAgentId: source,
              targetAgentId,
              action,
              reviewId,
              status,
            });
            const lifecycle = {
              status,
              routing_state: status,
              role: 'archived_specialist',
              action: action.type,
              automatic_routing: false,
              permissions: ARCHIVED_PERMISSIONS,
              target_agents: action.target_agents || [],
              memory_migration_plan: action.memory_migration_plan || '',
              updated_by_review_id: reviewId,
              updated_at: nowIso(),
            };
            writeTextAtomicSync(path.join(dir, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
            const agentJsonPath = path.join(dir, 'agent.json');
            const agentJson = safeJsonParse(readText(agentJsonPath, '{}'), {});
            if (agentJson && typeof agentJson === 'object' && !Array.isArray(agentJson)) {
              agentJson.enabled = false;
              agentJson.routing_state = status;
              agentJson.disabled_by_hr_review = reviewId;
              agentJson.disabled_reason = status;
              agentJson.lifecycle = {
                ...(agentJson.lifecycle && typeof agentJson.lifecycle === 'object' && !Array.isArray(agentJson.lifecycle) ? agentJson.lifecycle : {}),
                ...lifecycle,
              };
              writeTextAtomicSync(agentJsonPath, JSON.stringify(agentJson, null, 2));
            }
          }
        }
      }
    }
  },

  createNewDepartment(action, reviewId = '') {
    const config = action.new_department || {};
    const departmentId = String(config.id || '').trim();
    if (!departmentId) throw new Error('new_department is missing id.');
    const assessment = this.assessStructuralAgentAdmission({ departmentId, config: config.initial_agent || {}, action, reviewId });
    if (!assessment.passed) throw new Error(`Initial agent ${config.initial_agent?.id || ''} failed immediate admission assessment (score ${assessment.score}).`);
    const departmentDir = path.join(this.root, 'departments', departmentId);
    if (fs.existsSync(departmentDir)) throw new Error(`Department already exists: ${departmentId}`);
    ensureDirSync(departmentDir);
    writeTextAtomicSync(path.join(departmentDir, 'department.json'), JSON.stringify({
      id: departmentId,
      name: config.name,
      description: config.description,
      reference_department_id: config.reference_department_id,
      created_by_hr_review: reviewId,
      governance: {
        creation_approval: 'unanimous_highest_leads',
        boundary_assessment: config.boundary_assessment || [],
      },
    }, null, 2));

    const writeRole = (folder, roleConfig, role) => {
      const dir = path.join(departmentDir, folder);
      ensureDirSync(dir);
      writeTextAtomicSync(path.join(dir, 'agent.json'), JSON.stringify({
        id: roleConfig.id,
        name: roleConfig.name,
        description: roleConfig.description,
        skills: roleConfig.skills || [],
        system_prompt: roleConfig.system_prompt,
        self_evolution_prompt: roleConfig.self_evolution_prompt || '',
        debate_prompt: roleConfig.debate_prompt || '',
        enabled: true,
        role,
        rank: role === 'department_leader' ? 'lead' : undefined,
        created_by_hr_review: reviewId,
      }, null, 2));
      writeTextAtomicSync(path.join(dir, 'SKILL.md'), `---\nname: ${roleConfig.id}\ndescription: ${roleConfig.description}\n---\n\n# ${roleConfig.name}\n\n## Mission\n${roleConfig.description}\n\n## Governance\n- Follow the organization pattern referenced from ${config.reference_department_id}.\n`);
      writeTextAtomicSync(path.join(dir, 'MEMORY.md'), `# ${role === 'department_leader' ? 'Leader' : 'HR'} Memory: ${departmentId}\n\n## Stable Learnings\n- None yet.\n\n## Governance History\n- Department established by review ${reviewId}.\n\n## Do Not Store\n- Private user content, secrets, unpublished data, or one-off task facts.\n`);
    };
    writeRole('leader', config.leader, 'department_leader');
    writeRole('hr', config.hr, 'hr');

    const agent = config.initial_agent;
    const agentDir = path.join(departmentDir, 'agents', agent.id);
    ensureDirSync(agentDir);
    writeTextAtomicSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      skills: agent.skills,
      system_prompt: agent.system_prompt,
      self_evolution_prompt: agent.self_evolution_prompt,
      enabled: true,
      evolution: { interval_hours: 24, min_messages: DEFAULT_MIN_EVIDENCE_MESSAGES },
      lifecycle: {
        status: 'active',
        routing_state: 'active',
        role: 'specialist',
        automatic_routing: true,
        permissions: SPECIALIST_PERMISSIONS,
        created_by: 'new_department_review',
        started_by_review_id: reviewId,
        immediate_admission_assessment: assessment,
      },
      created_by_hr_review: reviewId,
    }, null, 2));
    writeTextAtomicSync(path.join(agentDir, 'lifecycle.json'), JSON.stringify({
      status: 'active',
      routing_state: 'active',
      role: 'specialist',
      automatic_routing: true,
      permissions: SPECIALIST_PERMISSIONS,
      started_by_review_id: reviewId,
      immediate_admission_assessment: assessment,
      created_at: nowIso(),
    }, null, 2));
    writeTextAtomicSync(path.join(agentDir, 'SKILL.md'), `---\nname: ${agent.id}\ndescription: ${agent.description}\n---\n\n# ${agent.name}\n\n## Mission\n${agent.description}\n\n## Core Workflow\n- Operate as an active specialist after passing immediate admission assessment.\n`);
    writeTextAtomicSync(path.join(agentDir, 'MEMORY.md'), `# Agent Memory: ${agent.id}\n\n## Stable Learnings\n- None yet.\n\n## Reusable Preferences\n- None yet.\n\n## Failure Modes\n- None yet.\n\n## Do Not Store\n- Private user content, secrets, unpublished data, and one-off task facts.\n`);
    run(
      this.db,
      `INSERT INTO specialist_experiments (
        id, department_id, candidate_agent_id, source_agent_id, status,
        baseline_agent_id, started_by_review_id, state, metrics_json,
        decision_notes, evaluation_json
      ) VALUES (?, ?, ?, '', 'active', '', ?, 'promoted', ?, ?, ?)`,
      [
        newId('experiment'), departmentId, agent.id, reviewId,
        JSON.stringify({ manual_runs: 0, auto_routed_runs: 0 }),
        'Initial specialist passed immediate admission assessment during department creation and was activated.',
        JSON.stringify({
          source_review_id: reviewId,
          reference_department_id: config.reference_department_id,
          lead_approval: 'unanimous',
          immediate_admission_assessment: assessment,
        }),
      ],
    );
  },

  transitionAgentCareer({ agentId, action, reviewerId = 'operator', reason = '', probationDays = 14 } = {}) {
    const agent = this.org.agent(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    if (isBuddyAgent(agent)) throw new Error('Buddy agent is excluded from Lab-level career actions. Periodic assessment may only roll back its Skill.');
    if (isGeneralAgent(agent)) throw new Error('The standalone Generalist participates in recruitment deliberation only and is excluded from assessment, promotion, demotion, probation, retirement, merge, and dismissal actions.');
    const normalizedAction = String(action || '').toLowerCase();
    if (!['promote', 'demote', 'probation', 'restore'].includes(normalizedAction)) {
      throw new Error('Career action must be promote, demote, probation, or restore.');
    }
    const ranks = ['junior', 'specialist', 'senior', 'lead'];
    const currentRank = ranks.includes(agent.rank) ? agent.rank : 'specialist';
    const currentIndex = ranks.indexOf(currentRank);
    let nextRank = currentRank;
    let patch;
    if (normalizedAction === 'promote') {
      nextRank = ranks[Math.min(ranks.length - 1, currentIndex + 1)];
      patch = {
        status: 'active', routing_state: 'active', rank: nextRank,
        role: nextRank === 'lead' ? 'lead_specialist' : 'specialist', automatic_routing: true,
        permissions: { ...SPECIALIST_PERMISSIONS, canLeadTask: ['senior', 'lead'].includes(nextRank), routingPriority: nextRank === 'lead' ? 20 : 40 },
        probation_until: '',
      };
    } else if (normalizedAction === 'demote') {
      nextRank = ranks[Math.max(0, currentIndex - 1)];
      patch = {
        status: 'active', routing_state: 'active', rank: nextRank, role: 'specialist', automatic_routing: true,
        permissions: { ...SPECIALIST_PERMISSIONS, canLeadTask: nextRank === 'senior', routingPriority: nextRank === 'junior' ? 70 : 50 },
        probation_until: '',
      };
    } else if (normalizedAction === 'probation') {
      patch = {
        status: 'probation', routing_state: 'paused', rank: currentRank, role: 'probationary_specialist', automatic_routing: false,
        permissions: CANARY_PERMISSIONS,
        probation_until: new Date(Date.now() + Math.max(1, Number(probationDays || 14)) * 24 * 60 * 60 * 1000).toISOString(),
      };
    } else {
      patch = {
        status: 'active', routing_state: 'active', rank: currentRank,
        role: currentRank === 'lead' ? 'lead_specialist' : 'specialist', automatic_routing: true,
        permissions: { ...SPECIALIST_PERMISSIONS, canLeadTask: ['senior', 'lead'].includes(currentRank) }, probation_until: '',
      };
    }
    this.writeAgentLifecycle(agent, { ...patch, updated_by: reviewerId, career_reason: reason, updated_at: nowIso() });
    this.store.recordGovernanceEvent({
      departmentId: agent.departmentId,
      agentId: agent.id,
      eventType: `career_${normalizedAction}`,
      status: patch.status,
      confidence: 1,
      rationale: reason || `${normalizedAction} applied by ${reviewerId}.`,
      payload: { previousRank: currentRank, nextRank, probationUntil: patch.probation_until || '', reviewerId },
    });
    return { agentId: agent.id, action: normalizedAction, previousRank: currentRank, nextRank, status: patch.status, probationUntil: patch.probation_until || '' };
  },

  migrateStructuralMemory({ departmentId, sourceAgentId, targetAgentId = '', action, reviewId = '', status = 'archived' }) {
    const migrationPlan = String(action.memory_migration_plan || '').trim();
    const auditActions = [];
    const sourceEntries = all(
      this.db,
      `SELECT * FROM memory_entries
       WHERE scope = 'agent'
         AND owner_id = ?
         AND lifecycle_state NOT IN ('archived', 'deleted', 'blocked')`,
      [sourceAgentId],
    );
    for (const row of sourceEntries) {
      if (row.privacy_level !== 'public_reusable') {
        this.store.transitionMemoryEntry(row.id, {
          lifecycleState: 'blocked',
          reviewStatus: 'structural_migration_private_block',
          updateReason: `Blocked during ${action.type}: ${migrationPlan}`,
          sourceKind: 'structural_memory_migration',
          sourceId: reviewId,
          reviewerId: reviewId || 'hr_structural_review',
        });
        auditActions.push(memoryMigrationAuditAction(row, 'block_private_source_memory', 'blocked', migrationPlan));
        continue;
      }

      let migrated = null;
      if (targetAgentId) {
        migrated = this.store.upsertMemoryEntry({
          scope: 'agent',
          ownerId: targetAgentId,
          departmentId: row.department_id || departmentId,
          agentId: targetAgentId,
          taskRunId: row.task_run_id || '',
          memoryType: row.memory_type,
          content: row.content,
          lifecycleState: 'candidate',
          confidence: Math.min(Number(row.confidence || 0.5), 0.72),
          privacyLevel: row.privacy_level,
          sourceKind: 'structural_memory_migration',
          sourceId: `${reviewId}:${row.id}`,
          reviewStatus: 'needs_hr_review',
          updateReason: `Migrated from ${sourceAgentId}: ${migrationPlan}`,
          reviewerId: reviewId || 'hr_structural_review',
        });
      }
      this.store.transitionMemoryEntry(row.id, {
        lifecycleState: 'archived',
        reviewStatus: targetAgentId ? 'structural_migrated_to_target' : 'structural_archived_with_agent',
        updateReason: targetAgentId
          ? `Migrated to ${targetAgentId} during ${action.type}: ${migrationPlan}`
          : `Archived during ${status}: ${migrationPlan}`,
        sourceKind: 'structural_memory_migration',
        sourceId: migrated?.id || reviewId,
        reviewerId: reviewId || 'hr_structural_review',
      });
      auditActions.push(memoryMigrationAuditAction(
        row,
        targetAgentId ? 'migrate_to_target_and_archive_source' : 'archive_source_memory',
        'archived',
        migrationPlan,
        { targetAgentId, migratedMemoryEntryId: migrated?.id || '' },
      ));
    }

    const typedRows = all(
      this.db,
      `SELECT * FROM typed_memories
       WHERE status = 'active'
         AND (agent_id = ? OR (scope = 'agent' AND owner_id = ?))`,
      [sourceAgentId, sourceAgentId],
    );
    for (const row of typedRows) {
      let migrated = null;
      if (targetAgentId && row.privacy_level === 'public_reusable') {
        migrated = upsertTypedMemory(this.db, {
          scope: row.scope || 'agent',
          ownerId: targetAgentId,
          departmentId: row.department_id || departmentId,
          agentId: targetAgentId,
          memoryType: row.memory_type,
          content: row.content,
          confidence: Math.min(Number(row.confidence || 0.64), 0.72),
          evidenceCount: Number(row.evidence_count || 1),
          sourceKind: 'structural_memory_migration',
          sourceId: `${reviewId}:${row.id}`,
        });
      }
      run(
        this.db,
        `UPDATE typed_memories
         SET status = 'archived', source_kind = ?, source_id = ?, updated_at = ?
         WHERE id = ?`,
        [
          targetAgentId ? 'structural_memory_migration_archived_after_copy' : 'structural_memory_migration_archived',
          migrated?.id || reviewId,
          nowIso(),
          row.id,
        ],
      );
      auditActions.push({
        action: targetAgentId ? 'migrate_typed_memory_and_archive_source' : 'archive_typed_memory',
        memoryEntryId: row.id,
        scope: row.scope,
        ownerId: row.owner_id,
        memoryType: row.memory_type,
        fromState: 'active',
        toState: 'archived',
        reason: migrationPlan,
        targetAgentId,
        migratedTypedMemoryId: migrated?.id || '',
      });
    }

    if (auditActions.length) {
      this.store.recordMemoryAudit({ scope: 'agent', ownerId: sourceAgentId, actions: auditActions });
    }
    return auditActions;
  },

  writeAgentLifecycle(agent, patch) {
    const dir = path.join(this.root, 'departments', agent.departmentId, 'agents', agent.id);
    const lifecyclePath = path.join(dir, 'lifecycle.json');
    const agentJsonPath = path.join(dir, 'agent.json');
    const lifecycle = {
      ...(safeJsonParse(readText(lifecyclePath, '{}'), {}) || {}),
      ...patch,
    };
    writeTextAtomicSync(lifecyclePath, JSON.stringify(lifecycle, null, 2));
    const agentJson = safeJsonParse(readText(agentJsonPath, '{}'), {});
    if (agentJson && typeof agentJson === 'object' && !Array.isArray(agentJson)) {
      agentJson.enabled = !['retired', 'merged', 'disabled', 'rejected'].includes(String(patch.status || '').toLowerCase());
      agentJson.routing_state = patch.routing_state || patch.status || agentJson.routing_state || '';
      agentJson.lifecycle = {
        ...(agentJson.lifecycle && typeof agentJson.lifecycle === 'object' && !Array.isArray(agentJson.lifecycle) ? agentJson.lifecycle : {}),
        ...patch,
      };
      writeTextAtomicSync(agentJsonPath, JSON.stringify(agentJson, null, 2));
    }
  },

  recordStructuralGovernanceEvents({ departmentId, reviewId, structural }) {
    for (const action of structural?.decisions?.actions || []) {
      const sourceAgents = action.source_agents?.length ? action.source_agents : [''];
      for (const agentId of sourceAgents) {
        this.store.recordGovernanceEvent({
          departmentId,
          agentId,
          eventType: action.type || 'unknown',
          status: action.validation_status || action.status || '',
          evidenceCount: Number(action.evidence_count || 0),
          confidence: Number(action.confidence || 0),
          rationale: action.evidence_summary || '',
          migrationPlan: action.memory_migration_plan || '',
          payload: action,
          sourceReviewId: reviewId,
        });
      }
    }
  },

  recordDepartmentPerformanceReviews({ departmentId, agents, sourceReviewId }) {
    for (const agent of agents) {
      if (!labGovernancePolicy(agent).assessment) continue;
      const stats = get(
        this.db,
        `SELECT
           COUNT(*) AS task_count,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count
         FROM task_nodes
         WHERE agent_id = ?`,
        [agent.id],
      ) || {};
      const comm = get(
        this.db,
        `SELECT COUNT(*) AS count
         FROM communications
         WHERE from_agent_id = ? OR to_agent_id = ?`,
        [agent.id, agent.id],
      ) || {};
      const memoryHealth = this.memoryHealthForAgent(agent.id);
      const taskCount = Number(stats.task_count || 0);
      const successCount = Number(stats.success_count || 0);
      const failureCount = Number(stats.failure_count || 0);
      const rating = taskCount === 0
        ? 'insufficient_evidence'
        : failureCount > successCount && taskCount >= 3
        ? 'observe'
        : successCount >= 3 && failureCount === 0
          ? 'excellent'
          : 'qualified';
      this.store.recordPerformanceReview({
        departmentId,
        agentId: agent.id,
        reviewType: 'periodic',
        rating,
        taskCount,
        successCount,
        failureCount,
        communicationCount: Number(comm.count || 0),
        memoryHealth,
        recommendation: rating === 'insufficient_evidence'
          ? 'Collect completed task evidence before making promotion, demotion, recruitment, or retirement decisions.'
          : rating === 'observe'
          ? 'Review failure modes and memory quality before expanding responsibility.'
          : 'Maintain current responsibilities; consider promotion only after controlled task-lead trial evidence.',
        sourceReviewId,
      });
    }
  }
  });
}
