const TASK_RANK_SCORE = Object.freeze({
  junior: 1,
  specialist: 2,
  senior: 3,
  lead: 4,
});

export function selectTaskLeader(participants = [], { prompt = '', departmentId = '', fallbackAgentId = '' } = {}) {
  const ranked = (Array.isArray(participants) ? participants : [])
    .filter((item) => item?.agentId)
    .map((item) => ({
      ...item,
      leadershipLevelScore: leadershipLevelScore(item.leadershipLevel),
      leadershipScore: boundedNumber(item.leadershipScore, 0, 100),
      rankScore: TASK_RANK_SCORE[String(item.rank || '').toLowerCase()] || 2,
      performanceLevelScore: performanceLevelScore(item.performanceLevel),
      relevanceScore: Number.isFinite(Number(item.relevanceScore))
        ? Number(item.relevanceScore)
        : taskLeaderRelevance(item, prompt, departmentId),
    }))
    .sort((left, right) => (
      right.leadershipLevelScore - left.leadershipLevelScore
      || right.leadershipScore - left.leadershipScore
      || right.rankScore - left.rankScore
      || right.performanceLevelScore - left.performanceLevelScore
      || right.relevanceScore - left.relevanceScore
      || String(left.agentInstanceId || '').localeCompare(String(right.agentInstanceId || ''))
      || String(left.agentId).localeCompare(String(right.agentId))
    ));
  const selected = ranked[0];
  if (!selected) return {
    agentId: fallbackAgentId || '', agentInstanceId: '', policy: 'ubuddy_task_leader_v2',
    reason: 'fallback_no_participant_metadata', candidates: [], coordinationMode: 'appointed_agent_leader',
  };
  return {
    agentId: selected.agentId,
    agentInstanceId: selected.agentInstanceId || '',
    policy: 'ubuddy_task_leader_v2',
    reason: 'highest_leadership_level_score_rank_performance_and_task_relevance',
    rank: selected.rank || 'specialist',
    rankScore: selected.rankScore,
    relevanceScore: selected.relevanceScore,
    leadershipLevel: selected.leadershipLevel || 'L0',
    leadershipScore: selected.leadershipScore,
    performanceLevel: selected.performanceLevel || 'P1',
    leadershipEligible: true,
    leadershipTrialApproved: Boolean(selected.leadershipTrialApproved),
    leadershipTrialActionId: selected.leadershipTrialActionId || '',
    leadershipTrialRole: selected.leadershipTrialRole || '',
    coordinationMode: 'appointed_agent_leader',
    candidates: ranked.map((item) => ({
      agentId: item.agentId,
      agentInstanceId: item.agentInstanceId || '',
      rank: item.rank || 'specialist',
      rankScore: item.rankScore,
      performanceLevel: item.performanceLevel || 'P1',
      performanceLevelScore: item.performanceLevelScore,
      relevanceScore: item.relevanceScore,
      leadershipLevel: item.leadershipLevel || 'L0',
      leadershipScore: item.leadershipScore,
      leadershipEligible: true,
    })),
  };
}

export function ensureLeaderSynthesisNode(graph = [], leader = {}) {
  const nodes = (Array.isArray(graph) ? graph : []).map((node) => ({
    ...node,
    dependencies: [...new Set(Array.isArray(node?.dependencies) ? node.dependencies : [])],
  }));
  const participantKeys = new Set(nodes.map((node) => node.agentInstanceId || node.agentId).filter(Boolean));
  if (participantKeys.size <= 1) return nodes;
  const currentFinal = nodes.find((node) => node.isFinal)
    || nodes.find((node) => node.localId === 'leader_synthesis')
    || nodes.at(-1);
  if (currentFinal && nodeOwnedByLeader(currentFinal, leader)) {
    for (const node of nodes) node.isFinal = node === currentFinal;
    return nodes;
  }
  for (const node of nodes) node.isFinal = false;
  const dependedOn = new Set(nodes.flatMap((node) => node.dependencies || []));
  const terminalBlockingIds = nodes
    .filter((node) => node.blocking !== false && !dependedOn.has(node.localId))
    .map((node) => node.localId)
    .filter(Boolean);
  const existingIds = new Set(nodes.map((node) => node.localId));
  let localId = 'leader_synthesis';
  for (let suffix = 2; existingIds.has(localId); suffix += 1) localId = `leader_synthesis_${suffix}`;
  nodes.push({
    localId,
    title: 'Leader synthesis and final delivery',
    objective: 'Review all blocking terminal outputs, resolve conflicts, and produce the final user-facing deliverable.',
    departmentId: leader.departmentId || currentFinal?.departmentId || '',
    agentId: leader.agentId || currentFinal?.agentId || '',
    agentInstanceId: leader.agentInstanceId || '',
    dependencies: [...new Set(terminalBlockingIds)],
    outputFormat: currentFinal?.outputFormat || 'A complete user-facing final result',
    estimatedMinutes: Math.max(10, Number(currentFinal?.estimatedMinutes || 20)),
    priority: Math.min(100, Math.max(1, Number(currentFinal?.priority || 50))),
    parallelGroup: 'final',
    blocking: true,
    notify: [],
    fallback: 'If synthesis cannot complete, produce a structured failure report with blockers and recovery actions.',
    maxAttempts: Math.max(1, Number(currentFinal?.maxAttempts || 3)),
    retryStrategy: currentFinal?.retryStrategy === 'never' ? 'never' : 'automatic',
    isFinal: true,
    nodeKind: 'leader_synthesis',
  });
  return nodes;
}

export function handleLeaderTaskEvent(task = {}, event = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const terminal = new Set(['completed', 'failed', 'cancelled', 'skipped']);
  const failed = nodes.filter((node) => node.status === 'failed');
  if (failed.length) return { wake: true, reason: 'recovery_exhausted', failureReport: buildLeaderFailureReport(task) };
  if (nodes.length && nodes.every((node) => terminal.has(node.status))) return { wake: true, reason: 'completion', payload: { event } };
  return { wake: false, reason: '', payload: { event } };
}

export function buildLeaderFailureReport(task = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const failedNodes = nodes.filter((node) => node.status === 'failed');
  const blockedNodes = nodes.filter((node) => ['blocked', 'waiting', 'retry_wait'].includes(node.status));
  return {
    taskRunId: task.id || '',
    leaderAgentId: task.leadAgentId || '',
    leaderAgentInstanceId: task.leadAgentInstanceId || '',
    summary: failedNodes.length
      ? `${failedNodes.length} task node(s) failed after recovery.`
      : `${blockedNodes.length} task node(s) remain blocked.`,
    failedNodes: failedNodes.map(publicNodeFailure),
    blockedNodes: blockedNodes.map(publicNodeFailure),
    attemptedActions: [...new Set(nodes.flatMap((node) => node.recoveryActions || []))].slice(-12),
    suggestedNextStep: failedNodes.length ? 'Retry failed nodes or revise the task graph.' : 'Resolve the reported blockers and resume the task.',
  };
}

function publicNodeFailure(node = {}) {
  return {
    nodeId: node.id || '', title: node.title || '', agentId: node.agentId || '',
    agentInstanceId: node.agentInstanceId || '', status: node.status || '', errorCode: node.lastErrorCode || '',
    error: node.errorText || '', waitReason: node.waitReason || '', attemptCount: Number(node.attemptCount || 0),
    maxAttempts: Number(node.maxAttempts || 0), recoveryActions: (node.recoveryActions || []).slice(-8),
  };
}

function nodeOwnedByLeader(node = {}, leader = {}) {
  if (leader.agentInstanceId && node.agentInstanceId) return leader.agentInstanceId === node.agentInstanceId;
  return Boolean(leader.agentId && node.agentId === leader.agentId);
}

function leadershipLevelScore(value = '') {
  return Math.max(0, Math.min(3, Number(String(value || 'L0').replace(/^L/i, '')) || 0));
}

function performanceLevelScore(value = '') {
  return Math.max(1, Math.min(10, Number(String(value || 'P1').replace(/^P/i, '')) || 1));
}

function boundedNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function taskLeaderRelevance(participant = {}, prompt = '', departmentId = '') {
  const text = String(prompt || '').toLowerCase();
  const corpus = [participant.agentId, participant.name, participant.description, participant.systemPrompt,
    participant.effectiveSkill, ...(participant.skills || [])].filter(Boolean).join(' ').toLowerCase();
  let score = participant.departmentId === departmentId ? 1 : 0;
  const tokens = text.match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
  score += [...new Set(tokens)].filter((token) => corpus.includes(token)).length * 0.15;
  return Number(score.toFixed(3));
}
