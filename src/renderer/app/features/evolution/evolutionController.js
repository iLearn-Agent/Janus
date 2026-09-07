export function createEvolutionController({
  api,
  state,
  render,
  notify,
  appendStatus,
  shortHash,
  runCodexConnectionTest,
  notificationToneForConnectionTest,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let evolutionDemoTimer = null;

  function clearEvolutionDemoTimer() {
    if (!evolutionDemoTimer) return;
    clearTimer(evolutionDemoTimer);
    evolutionDemoTimer = null;
  }

  function waitForEvolutionDemoStep(ms = 420) {
    clearEvolutionDemoTimer();
    return new Promise((resolve) => {
      evolutionDemoTimer = setTimer(() => {
        evolutionDemoTimer = null;
        resolve();
      }, ms);
    });
  }

  function beginEvolutionProgress({ demo = false } = {}) {
    const timestamp = new Date().toISOString();
    const runId = `${demo ? 'demo' : 'run'}-${Date.now()}`;
    const initialEvent = {
      runId,
      stage: 'start',
      label: demo ? '演示流程启动' : '维护启动',
      status: 'running',
      detail: demo ? '当前没有真实对话证据，先走一遍自进化演示流程。' : '开始执行自进化维护链路。',
      timestamp,
      demo,
    };
    state.evolutionProgress = {
      runId,
      demo,
      running: true,
      startedAt: timestamp,
      completedAt: '',
      stages: { start: initialEvent },
      events: [initialEvent],
    };
  }

  function handleEvolutionProgress(payload = {}) {
    const stage = String(payload.stage || '').trim();
    if (!stage) return;
    const previous = state.evolutionProgress || { stages: {}, events: [] };
    const runId = payload.maintenanceRunId || payload.runId || previous.runId || `run-${Date.now()}`;
    const event = {
      ...payload,
      runId,
      timestamp: payload.timestamp || new Date().toISOString(),
      demo: Boolean(payload.demo ?? previous.demo),
    };
    const nextStages = { ...(previous.stages || {}) };
    nextStages[stage] = { ...(nextStages[stage] || {}), ...event };
    const terminal = stage === 'complete' && ['success', 'failed'].includes(String(payload.status || ''));
    state.evolutionProgress = {
      ...previous,
      runId,
      demo: event.demo,
      running: terminal ? false : true,
      completedAt: terminal ? event.timestamp : previous.completedAt || '',
      stages: nextStages,
      events: [event, ...(previous.events || [])].slice(0, 40),
    };
    if (state.currentTab === 'evolution') render();
  }

  function finishEvolutionProgress(status, detail = '') {
    handleEvolutionProgress({
      stage: 'complete',
      label: status === 'success' ? '流程完成' : '流程失败',
      status,
      detail,
      demo: Boolean(state.evolutionProgress?.demo),
    });
  }

  function shouldUseEvolutionDemoFlow() {
    const overview = state.evolution || {};
    const latestRuns = Array.isArray(overview.latestRuns) ? overview.latestRuns : [];
    const evidenceTotal = latestRuns.reduce((sum, run) => sum + Number(run.evidenceMessageCount || run.evidence_message_count || 0), 0);
    const archiveTotal = Array.isArray(overview.archives) ? overview.archives.length : 0;
    return evidenceTotal <= 0 && archiveTotal <= 0;
  }

  async function runEvolutionDemoFlow() {
    const events = [
      ['evidence', 'running', '证据读取', '检查最近聊天、agent 可见消息和记忆变更来源。'],
      ['evidence', 'success', '证据读取', '当前没有真实对话数据，载入一组演示证据用于走通流程。'],
      ['diagnosis', 'running', '轨迹诊断', '分析用户意图、agent 响应质量、工具调用和记忆命中情况。'],
      ['diagnosis', 'success', '轨迹诊断', '定位到“技能步骤可细化、记忆策略需复核”的演示问题。'],
      ['proposal', 'running', 'Proposal', '生成 memory / skill 调整草案，并记录改动理由。'],
      ['proposal', 'success', 'Proposal', '演示草案已生成：补充执行准则、保留原有能力边界。'],
      ['gate', 'running', 'Gate 裁决', '检查格式、权限、隐私和变更范围。'],
      ['gate', 'success', 'Gate 裁决', '演示草案通过 gate，未发现越权或隐私风险。'],
      ['apply', 'running', '应用与回归', '模拟写入前快照、回归样例和变更验证。'],
      ['apply', 'success', '应用与回归', '演示回归通过；当前不写入真实 Skill / Memory。'],
      ['organization', 'running', '组织校验', 'HR 视角检查是否需要候选、晋升、退休或职责迁移。'],
      ['organization', 'success', '组织校验', '演示结论：无需调整组织结构，仅记录观察。'],
      ['hr', 'running', 'HR 复核', '汇总诊断、proposal、gate 和回归结果。'],
      ['hr', 'success', 'HR 复核', '演示复核完成：建议等待真实对话数据后再执行真实自进化。'],
      ['complete', 'success', '演示流程完成', '已完整走过自进化伪流程；接入真实对话后可切换为真实维护。'],
    ];
    for (let index = 0; index < events.length; index += 1) {
      const [stage, status, label, detail] = events[index];
      handleEvolutionProgress({ stage, status, label, detail, demo: true });
      if (index < events.length - 1) await waitForEvolutionDemoStep();
    }
  }

  async function runEvolution() {
    if (state.busy) return;
    const useDemoFlow = shouldUseEvolutionDemoFlow();
    clearEvolutionDemoTimer();
    beginEvolutionProgress({ demo: useDemoFlow });
    state.busy = true;
    render();
    try {
      if (useDemoFlow) {
        await runEvolutionDemoFlow();
        state.evolution = await api.evolutionOverview();
        notify('当前没有真实对话数据，已走完一遍自进化演示流程。', 'success');
      } else {
        await api.runEvolution({ dryRun: state.dryRunEvolution, llmDiagnosis: !state.dryRunEvolution, autoApply: true });
        state.evolution = await api.evolutionOverview();
        finishEvolutionProgress('success', state.dryRunEvolution ? '自进化 dry run 已完成。' : '维护运行已完成。');
        notify(state.dryRunEvolution ? '自进化 dry run 已完成。' : '维护运行已完成。', 'success');
      }
    } catch (error) {
      finishEvolutionProgress('failed', error.message || String(error));
      appendStatus(`Evolution error: ${error.message || error}`);
      notify(`维护运行失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      clearEvolutionDemoTimer();
      render();
    }
  }

  async function applyMemoryPolicy() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await api.applyMemoryPolicy({});
      state.evolution = await api.evolutionOverview();
      notify('记忆生命周期策略已应用。', 'success');
    } catch (error) {
      appendStatus(`Memory policy error: ${error.message || error}`);
      notify(`应用记忆策略失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function labelArchive(runId, archiveId, label) {
    if (!runId || state.busy) return;
    state.busy = true;
    render();
    try {
      await api.labelArchive({
        runId,
        archiveId,
        label: label === 'positive',
        labelSource: 'human',
        confidence: 1,
        rationale: label === 'positive' ? 'Operator marked this applied evolution as useful.' : 'Operator marked this applied evolution as not useful.',
      });
      state.evolution = await api.evolutionOverview();
      notify(label === 'positive' ? '已标记为有用演化。' : '已标记为退化演化。', 'success');
    } catch (error) {
      appendStatus(`Archive label error: ${error.message || error}`);
      notify(`标记 archive 失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function calibrateGate() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await api.calibrateGate({ minSamples: 4 });
      appendStatus(`Gate calibration: ${result.status || 'unknown'}`);
      state.evolution = await api.evolutionOverview();
      notify(`Gate 校准结果：${result.status || 'unknown'}`, result.status === 'calibrated' ? 'success' : 'warning');
    } catch (error) {
      appendStatus(`Gate calibration error: ${error.message || error}`);
      notify(`Gate 校准失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function rollbackSkill(skillVersionId) {
    if (!skillVersionId || state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await api.rollbackSkill({
        skillVersionId,
        reviewerId: 'desktop_operator',
        reason: 'Operator restored a recorded skill version from the desktop governance UI.',
      });
      appendStatus(`Skill rollback applied for ${result.agentId}: ${shortHash(result.restoredSkillHash)}`);
      state.evolution = await api.evolutionOverview();
      notify(`已回滚 ${result.agentId || 'agent'} 的 skill。`, 'success');
    } catch (error) {
      appendStatus(`Skill rollback error: ${error.message || error}`);
      notify(`Skill 回滚失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function startSpecialistExperiment(experimentId) {
    if (!experimentId || state.busy) return;
    state.busy = true;
    render();
    try {
      await api.startSpecialistExperiment({ experimentId });
      state.evolution = await api.evolutionOverview();
      state.tasks = await api.listTasks();
      notify('候选 Agent 对照考核已启动。', 'success');
    } catch (error) {
      appendStatus(`Specialist trial error: ${error.message || error}`);
      notify(`启动专家实验失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function evaluateSpecialistExperiment(experimentId) {
    if (!experimentId || state.busy) return;
    state.busy = true;
    render();
    try {
      await api.evaluateSpecialistExperiment({ experimentId });
      state.evolution = await api.evolutionOverview();
      notify('专家实验评估已完成。', 'success');
    } catch (error) {
      appendStatus(`Specialist evaluation error: ${error.message || error}`);
      notify(`专家实验评估失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function finalizeSpecialistExperiment(experimentId, decision) {
    if (!experimentId || !decision || state.busy) return;
    state.busy = true;
    render();
    try {
      await api.finalizeSpecialistExperiment({ experimentId, decision, reviewerId: 'desktop_operator' });
      const boot = await api.bootstrap();
      state.org = boot.org;
      state.evolution = boot.evolution;
      notify(decision === 'promote' ? '专家已提升为正式 agent。' : '专家实验已拒绝并归档。', 'success');
    } catch (error) {
      appendStatus(`Specialist decision error: ${error.message || error}`);
      notify(`专家实验决策失败：${error.message || error}`, 'error');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runDoctor() {
    try {
      state.currentTab = 'settings';
      const test = await runCodexConnectionTest('正在手动执行 Janus 模型通路测试...');
      notify(test.passed ? 'Janus 模型通路可用。' : 'Janus 模型通路测试失败。', notificationToneForConnectionTest(test));
    } catch (error) {
      appendStatus(`Janus model diagnostics error: ${error.message || error}`);
      notify(`Janus 模型诊断失败：${error.message || error}`, 'error');
    }
  }

  async function refreshUBuddyOrganizationEvolution() {
    if (state.uBuddyOrganizationEvolutionBusy) return;
    state.uBuddyOrganizationEvolutionBusy = 'refresh';
    render();
    try {
      state.uBuddyOrganizationEvolution = await api.uBuddyOrganizationEvolutionOverview();
    } catch (error) {
      notify(`无法读取 uBuddy 组织策略：${error.message || error}`, 'error');
    } finally {
      state.uBuddyOrganizationEvolutionBusy = '';
      render();
    }
  }

  async function activateUBuddyOrganizationEvolution(policyVersionId = '') {
    if (!policyVersionId || state.uBuddyOrganizationEvolutionBusy) return;
    state.uBuddyOrganizationEvolutionBusy = policyVersionId;
    render();
    try {
      state.uBuddyOrganizationEvolution = await api.activateUBuddyOrganizationEvolution({
        policyVersionId,
        expectedActivePolicyVersionId: state.uBuddyOrganizationEvolution?.activePolicyVersionId || '',
      });
      notify('uBuddy 组织策略已激活。', 'success');
    } catch (error) {
      notify(`无法激活 uBuddy 组织策略：${error.message || error}`, 'error');
    } finally {
      state.uBuddyOrganizationEvolutionBusy = '';
      render();
    }
  }

  async function disableUBuddyOrganizationEvolution() {
    if (state.uBuddyOrganizationEvolutionBusy) return;
    state.uBuddyOrganizationEvolutionBusy = 'disable';
    render();
    try {
      state.uBuddyOrganizationEvolution = await api.disableUBuddyOrganizationEvolution({
        expectedActivePolicyVersionId: state.uBuddyOrganizationEvolution?.activePolicyVersionId || '',
        reason: 'user_disabled',
      });
      notify('uBuddy 已恢复基础组织策略。', 'success');
    } catch (error) {
      notify(`无法停用 uBuddy 组织策略：${error.message || error}`, 'error');
    } finally {
      state.uBuddyOrganizationEvolutionBusy = '';
      render();
    }
  }

  return {
    activateUBuddyOrganizationEvolution,
    applyMemoryPolicy,
    beginEvolutionProgress,
    calibrateGate,
    clearEvolutionDemoTimer,
    disableUBuddyOrganizationEvolution,
    evaluateSpecialistExperiment,
    finalizeSpecialistExperiment,
    finishEvolutionProgress,
    handleEvolutionProgress,
    labelArchive,
    rollbackSkill,
    refreshUBuddyOrganizationEvolution,
    runDoctor,
    runEvolution,
    startSpecialistExperiment,
  };
}
