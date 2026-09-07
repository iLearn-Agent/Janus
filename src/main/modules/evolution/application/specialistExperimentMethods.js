export function installSpecialistExperimentMethods(prototype, dependencies) {
  const {
    ARCHIVED_PERMISSIONS,
    SPECIALIST_PERMISSIONS,
    get,
    nowIso,
    run,
    safeJsonParse,
    specialistExperimentIncludesBuddy,
    taskReplayMetrics,
  } = dependencies;
  Object.assign(prototype, {
  startSpecialistExperiment({ experimentId, sourceTaskRunId = '', prompt = '' } = {}) {
    const experiment = this.specialistExperimentRow(experimentId);
    if (!experiment) throw new Error(`Specialist experiment not found: ${experimentId}`);
    if (specialistExperimentIncludesBuddy(experiment)) throw new Error('Buddy agent is excluded from specialist experiments.');
    const departmentId = experiment.department_id;
    const candidateAgentId = experiment.candidate_agent_id;
    const baselineAgentId = experiment.baseline_agent_id || experiment.source_agent_id;
    const candidate = this.org.agent(candidateAgentId);
    const baseline = this.org.agent(baselineAgentId);
    if (!candidate) throw new Error(`Candidate agent not found: ${candidateAgentId}`);
    if (!baseline) throw new Error(`Baseline agent not found: ${baselineAgentId}`);

    const sourceTask = sourceTaskRunId ? this.store.getTaskRun(sourceTaskRunId) : this.latestCompletedTaskForDepartment(departmentId);
    const replayPrompt = String(prompt || sourceTask?.prompt || '').trim();
    if (!replayPrompt) throw new Error('A specialist experiment needs a source task or prompt to replay.');
    const sourceSummary = sourceTask
      ? `Replay source task ${sourceTask.id}: ${sourceTask.title}`
      : 'Replay operator-provided candidate assessment prompt.';

    const baselineTask = this.createSpecialistReplayTask({
      title: `Baseline replay: ${candidateAgentId}`,
      prompt: replayPrompt,
      departmentId,
      agentId: baselineAgentId,
      candidateAgentId,
      sourceSummary,
      phase: 'baseline',
    });
    const candidateTask = this.createSpecialistReplayTask({
      title: `Candidate replay: ${candidateAgentId}`,
      prompt: replayPrompt,
      departmentId,
      agentId: candidateAgentId,
      candidateAgentId,
      sourceSummary,
      phase: 'candidate',
    });
    const metrics = {
      ...safeJsonParse(experiment.metrics_json, {}),
      manual_runs: Number(safeJsonParse(experiment.metrics_json, {}).manual_runs || 0) + 1,
      auto_routed_runs: Number(safeJsonParse(experiment.metrics_json, {}).auto_routed_runs || 0),
      latest_source_task_run_id: sourceTask?.id || '',
      latest_baseline_task_run_id: baselineTask.id,
      latest_candidate_task_run_id: candidateTask.id,
    };
    run(
      this.db,
      `UPDATE specialist_experiments
       SET baseline_task_run_id = ?, candidate_task_run_id = ?, state = 'running',
           status = 'running', metrics_json = ?, updated_at = ?
       WHERE id = ?`,
      [baselineTask.id, candidateTask.id, JSON.stringify(metrics), nowIso(), experiment.id],
    );
    this.store.recordGovernanceEvent({
      departmentId,
      agentId: candidateAgentId,
      eventType: 'specialist_assessment_started',
      status: 'running',
      rationale: sourceSummary,
      payload: { experimentId: experiment.id, baselineTaskRunId: baselineTask.id, candidateTaskRunId: candidateTask.id },
      sourceReviewId: experiment.started_by_review_id || '',
    });
    return {
      experimentId: experiment.id,
      baselineTask,
      candidateTask,
      state: 'running',
      metrics,
    };
  },

  evaluateSpecialistExperiment({ experimentId } = {}) {
    const experiment = this.specialistExperimentRow(experimentId);
    if (!experiment) throw new Error(`Specialist experiment not found: ${experimentId}`);
    if (specialistExperimentIncludesBuddy(experiment)) throw new Error('Buddy agent is excluded from specialist experiments.');
    const baselineTask = experiment.baseline_task_run_id ? this.store.getTaskRun(experiment.baseline_task_run_id) : null;
    const candidateTask = experiment.candidate_task_run_id ? this.store.getTaskRun(experiment.candidate_task_run_id) : null;
    if (!baselineTask || !candidateTask) throw new Error('Specialist experiment has not started a baseline/candidate replay pair.');

    const baseline = taskReplayMetrics(baselineTask);
    const candidate = taskReplayMetrics(candidateTask);
    const scoreDelta = Number((candidate.score - baseline.score).toFixed(3));
    const candidateComplete = ['completed', 'failed', 'waiting'].includes(candidateTask.status);
    const baselineComplete = ['completed', 'failed', 'waiting'].includes(baselineTask.status);
    let decision = 'needs_more_evidence';
    if (baselineComplete && candidateComplete) {
      if (candidate.failedNodes === 0 && scoreDelta >= 1) decision = 'promote_candidate';
      else if (candidate.failedNodes > baseline.failedNodes || scoreDelta <= -1) decision = 'reject_candidate';
    }
    const evaluation = {
      decision,
      score_delta: scoreDelta,
      baseline,
      candidate,
      evaluated_at: nowIso(),
      rule: 'Promote only when the candidate completes without failed nodes and beats baseline by at least 1 deterministic score point.',
    };
    const previousMetrics = safeJsonParse(experiment.metrics_json, {});
    const metrics = {
      ...previousMetrics,
      latest_decision: decision,
      latest_score_delta: scoreDelta,
      baseline_score: baseline.score,
      candidate_score: candidate.score,
    };
    run(
      this.db,
      `UPDATE specialist_experiments
       SET state = ?, metrics_json = ?, evaluation_json = ?, updated_at = ?
       WHERE id = ?`,
      [decision, JSON.stringify(metrics), JSON.stringify(evaluation), nowIso(), experiment.id],
    );
    this.store.recordGovernanceEvent({
      departmentId: experiment.department_id,
      agentId: experiment.candidate_agent_id,
      eventType: 'specialist_assessment_evaluated',
      status: decision,
      confidence: Math.min(0.95, Math.max(0.5, Math.abs(scoreDelta) / 5)),
      rationale: `Candidate score delta ${scoreDelta}; decision=${decision}.`,
      payload: { experimentId: experiment.id, evaluation },
      sourceReviewId: experiment.started_by_review_id || '',
    });
    return { experimentId: experiment.id, state: decision, evaluation, metrics };
  },

  finalizeSpecialistExperiment({ experimentId, decision, reviewerId = 'operator' } = {}) {
    const experiment = this.specialistExperimentRow(experimentId);
    if (!experiment) throw new Error(`Specialist experiment not found: ${experimentId}`);
    if (specialistExperimentIncludesBuddy(experiment)) throw new Error('Buddy agent is excluded from specialist experiments.');
    const normalizedDecision = String(decision || '').trim().toLowerCase();
    if (!['promote', 'reject'].includes(normalizedDecision)) {
      throw new Error('Specialist experiment decision must be promote or reject; an Agent may not remain in canary state.');
    }
    const candidate = this.org.agent(experiment.candidate_agent_id);
    if (!candidate) throw new Error(`Candidate agent not found: ${experiment.candidate_agent_id}`);
    const promoted = normalizedDecision === 'promote';
    const state = promoted ? 'promoted' : 'rejected';
    const status = promoted ? 'active' : 'rejected';
    run(
      this.db,
      `UPDATE specialist_experiments
       SET state = ?, status = ?, decision_notes = ?, updated_at = ?
       WHERE id = ?`,
      [
        state,
        status,
        `${state} by ${reviewerId} after controlled baseline/candidate evaluation.`,
        nowIso(),
        experiment.id,
      ],
    );
    this.writeAgentLifecycle(candidate, promoted
      ? {
          status: 'active',
          routing_state: 'active',
          role: 'specialist',
          automatic_routing: true,
          permissions: SPECIALIST_PERMISSIONS,
          promoted_by: reviewerId,
          promoted_from_experiment_id: experiment.id,
          updated_at: nowIso(),
        }
      : {
          status: 'retired',
          routing_state: 'retired',
          role: 'archived_specialist',
          automatic_routing: false,
          permissions: ARCHIVED_PERMISSIONS,
          rejected_by: reviewerId,
          rejected_from_experiment_id: experiment.id,
          updated_at: nowIso(),
        });
    this.store.recordGovernanceEvent({
      departmentId: experiment.department_id,
      agentId: experiment.candidate_agent_id,
      eventType: promoted ? 'specialist_promoted' : 'specialist_rejected',
      status,
      rationale: `${state} by ${reviewerId} after controlled candidate assessment.`,
      payload: { experimentId: experiment.id, decision: normalizedDecision },
      sourceReviewId: experiment.started_by_review_id || '',
    });
    return { experimentId: experiment.id, state, status };
  },

  specialistExperimentRow(experimentId) {
    return get(this.db, 'SELECT * FROM specialist_experiments WHERE id = ?', [experimentId]);
  },

  latestCompletedTaskForDepartment(departmentId) {
    const row = get(
      this.db,
      `SELECT id FROM task_runs
       WHERE department_id = ? AND status IN ('completed', 'failed')
       ORDER BY updated_at DESC LIMIT 1`,
      [departmentId],
    );
    return row ? this.store.getTaskRun(row.id) : null;
  },

  createSpecialistReplayTask({ title, prompt, departmentId, agentId, candidateAgentId, sourceSummary, phase }) {
    const task = this.store.createTaskRun({
      title,
      prompt,
      departmentId,
      leadAgentId: agentId,
      metadata: {
        planner: 'specialist_candidate_assessment_v1',
        phase,
        candidateAgentId,
        sourceSummary,
      },
    });
    this.store.createTaskNode({
      taskRunId: task.id,
      title,
      objective: `${sourceSummary}\n\nComplete the replay prompt as the ${phase} agent and produce a user-facing result plus notes on quality, communication cost, and reusable skill evidence.\n\nPrompt:\n${prompt}`,
      departmentId,
      agentId,
      status: 'ready',
      outputFormat: 'controlled replay result with quality, speed, communication, and reusable-skill notes',
      estimatedMinutes: 30,
      priority: 10,
      parallelGroup: `specialist_${phase}`,
      blocking: true,
      fallback: 'If replay cannot complete, state the missing capability and exact failure point.',
    });
    this.store.updateTaskRunStatus(task.id, 'ready');
    this.store.recordTaskEvent({
      taskRunId: task.id,
      eventType: 'specialist_replay_created',
      actorId: agentId,
      summary: `${phase} replay for candidate ${candidateAgentId}.`,
      payload: { phase, candidateAgentId, sourceSummary },
    });
    return this.store.getTaskRun(task.id);
  }

  });
}
