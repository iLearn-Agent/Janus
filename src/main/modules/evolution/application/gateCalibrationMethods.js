export function installGateCalibrationMethods(prototype, dependencies) {
  const {
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
  } = dependencies;
  Object.assign(prototype, {
  loadGateCalibration() {
    const row = get(
      this.db,
      `SELECT selected_min_score FROM evolution_gate_calibrations
       WHERE status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    );
    return row ? { ...DEFAULT_GATE_CALIBRATION, minScore: Number(row.selected_min_score || 0.72) } : undefined;
  },

  runRegressionEvals({ runId = '', agents = null, agentLookup = null, limit = 100 } = {}) {
    const options = {
      runId,
      limit,
      root: this.root,
      agentLookup: agentLookup || this.agentLookup(agents),
    };
    if (!REGRESSION_LLM_JUDGE_ENABLED) return runRegressionEvalCases(this.db, options);
    return runRegressionEvalCasesAsync(this.db, {
      ...options,
      judgeRunner: async (item) => {
        const raw = await runCodexExec({
          prompt: buildLlmJudgePrompt({
            agentId: item.agentId,
            caseText: item.caseText,
            inputText: item.inputText,
            expectedText: item.expectedText,
            skillText: item.skillText,
            memoryText: item.memoryText,
          }),
          agentId: item.agentId || 'regression',
          role: 'regression-judge',
          root: this.root,
          sandbox: 'read-only',
          timeoutMs: REGRESSION_LLM_TIMEOUT_MS,
          executionContext: this.modelExecutionContext(item.agentId || 'regression', 'regression_judge', {
            skill: item.skillText || '',
            memory: item.memoryText || '',
            metadata: { evolutionRunId: runId, evalId: item.id || '' },
          }),
        });
        return parseLlmJudgeResult(raw);
      },
    });
  },

  agentLookup(agents = null) {
    const selected = agents || this.org.list().agents;
    const lookup = {};
    for (const agent of selected) {
      const entry = {
        departmentId: agent.departmentId,
        skillPath: agentSkillPath(this.root, agent),
        memoryPath: agentMemoryPath(this.root, agent),
      };
      lookup[agent.id] = entry;
      lookup[`${agent.departmentId}:${agent.id}`] = entry;
    }
    return lookup;
  },

  recordArchiveLabel({
    runId,
    label,
    archiveId = '',
    labelSource = 'human',
    confidence = 1,
    rationale = '',
    synthetic = false,
  }) {
    const id = newId('label');
    run(
      this.db,
      `INSERT INTO evolution_archive_labels (
        id, run_id, archive_id, label, label_source, confidence, rationale, synthetic
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        runId,
        archiveId,
        label ? 1 : 0,
        String(labelSource || 'human').slice(0, 80),
        Math.max(0, Math.min(1, Number(confidence || 0))),
        clipText(rationale || '', 2000),
        synthetic ? 1 : 0,
      ],
    );
    return id;
  },

  archiveOutcomeRows({ includeSynthetic = false, limit = 200 } = {}) {
    const archives = all(
      this.db,
      `SELECT id, run_id, gate_score, gate_status, applied
       FROM evolution_archives
       ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return archives.map((archive) => {
      const label = get(
        this.db,
        `SELECT label, label_source, confidence, synthetic
         FROM evolution_archive_labels
         WHERE run_id = ? AND (? = 1 OR synthetic = 0)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [archive.run_id, includeSynthetic ? 1 : 0],
      );
      const evals = get(
        this.db,
        `SELECT COUNT(*) AS eval_count,
                SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS pass_count
         FROM evolution_regression_evals
         WHERE run_id = ?`,
        [archive.run_id],
      ) || {};
      const evalCount = Number(evals.eval_count || 0);
      const passCount = Number(evals.pass_count || 0);
      if (label) {
        return {
          archive_id: archive.id,
          run_id: archive.run_id,
          score: Number(archive.gate_score || 0),
          label: Boolean(label.label),
          eval_count: evalCount,
          label_source: label.label_source || 'explicit',
          label_confidence: Number(label.confidence || 1),
          synthetic: Boolean(label.synthetic),
        };
      }
      if (evalCount > 0) {
        const passRate = passCount / Math.max(1, evalCount);
        return {
          archive_id: archive.id,
          run_id: archive.run_id,
          score: Number(archive.gate_score || 0),
          label: passRate >= 0.75,
          eval_count: evalCount,
          eval_pass_rate: Number(passRate.toFixed(3)),
          label_source: 'regression_pass_rate',
          label_confidence: Number(Math.min(1, 0.5 + evalCount * 0.08).toFixed(3)),
          synthetic: false,
        };
      }
      return {
        archive_id: archive.id,
        run_id: archive.run_id,
        score: Number(archive.gate_score || 0),
        label: Boolean(archive.applied) && archive.gate_status === 'passed',
        eval_count: 0,
        label_source: 'applied_gate_fallback',
        label_confidence: 0.55,
        synthetic: false,
      };
    });
  },

  calibrateGateFromHistory({
    minSamples = 8,
    minPerClass = 1,
    defaultMinScore = 0.72,
    includeSynthetic = false,
  } = {}) {
    const rows = this.archiveOutcomeRows({ includeSynthetic });
    const positiveCount = rows.filter((row) => row.label).length;
    const negativeCount = rows.length - positiveCount;
    if (rows.length < minSamples || positiveCount < minPerClass || negativeCount < minPerClass) {
      return {
        status: 'insufficient_data',
        sample_count: rows.length,
        positive_count: positiveCount,
        negative_count: negativeCount,
        selected_min_score: defaultMinScore,
        min_samples: minSamples,
        min_per_class: minPerClass,
        include_synthetic: includeSynthetic,
        candidates: [],
      };
    }
    const candidates = [];
    for (let thresholdInt = 55; thresholdInt <= 95; thresholdInt += 1) {
      const threshold = thresholdInt / 100;
      let tp = 0;
      let fp = 0;
      let tn = 0;
      let fn = 0;
      for (const row of rows) {
        const predicted = row.score >= threshold;
        if (predicted && row.label) tp += 1;
        else if (predicted && !row.label) fp += 1;
        else if (!predicted && row.label) fn += 1;
        else tn += 1;
      }
      const precision = tp / Math.max(1, tp + fp);
      const recall = tp / Math.max(1, tp + fn);
      const f1 = (2 * precision * recall) / Math.max(0.0001, precision + recall);
      const accuracy = (tp + tn) / Math.max(1, rows.length);
      const falsePositiveRate = fp / Math.max(1, fp + tn);
      candidates.push({
        threshold,
        precision: Number(precision.toFixed(3)),
        recall: Number(recall.toFixed(3)),
        f1: Number(f1.toFixed(3)),
        accuracy: Number(accuracy.toFixed(3)),
        false_positive_rate: Number(falsePositiveRate.toFixed(3)),
        tp,
        fp,
        tn,
        fn,
      });
    }
    candidates.sort((a, b) => (
      b.f1 - a.f1 ||
      b.precision - a.precision ||
      b.accuracy - a.accuracy ||
      a.false_positive_rate - b.false_positive_rate ||
      Math.abs(a.threshold - defaultMinScore) - Math.abs(b.threshold - defaultMinScore)
    ));
    const best = candidates[0];
    run(this.db, "UPDATE evolution_gate_calibrations SET status = 'archived' WHERE status = 'active'");
    run(
      this.db,
      `INSERT INTO evolution_gate_calibrations (
        id, sample_count, positive_count, negative_count, selected_min_score,
        objective_json, candidates_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        newId('gatecal'),
        rows.length,
        positiveCount,
        negativeCount,
        best.threshold,
        JSON.stringify({
          metric: 'f1_then_precision_then_accuracy_then_false_positive_rate',
          best,
          min_samples: minSamples,
          min_per_class: minPerClass,
          include_synthetic: includeSynthetic,
          label_sources: [...new Set(rows.map((row) => row.label_source))].sort(),
        }),
        JSON.stringify(candidates),
      ],
    );
    return {
      status: 'calibrated',
      sample_count: rows.length,
      positive_count: positiveCount,
      negative_count: negativeCount,
      selected_min_score: best.threshold,
      include_synthetic: includeSynthetic,
      best,
      objective: best,
    };
  }
  });
}
