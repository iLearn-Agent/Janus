import { clipText } from '../../../utils.js';
import { selectTaskLeader } from './leaderCoordinator.js';

export function selectComplexTaskLeader({ agents = [], candidates: candidateSnapshots = [], prompt = '', departmentId = '', fallbackAgentId = '' } = {}) {
  const routableCandidates = agents.filter((agent) => agent?.id && agent.routable !== false);
  const agentById = new Map(routableCandidates.map((agent) => [agent.id, agent]));
  const participants = (Array.isArray(candidateSnapshots) ? candidateSnapshots : [])
    .filter((candidate) => agentById.has(candidate.agentId))
    .map((candidate) => ({ ...agentById.get(candidate.agentId), ...candidate, agentId: candidate.agentId }));
  if (!participants.length) {
    for (const agent of routableCandidates) participants.push({ ...agent, agentId: agent.id });
  }
  return selectTaskLeader(participants, { prompt, departmentId, fallbackAgentId });
}

export function buildGlobalTaskSummary(source = '') {
  const clean = String(source || '')
    .replace(/\n\n附加资源:\n[\s\S]*$/i, '')
    .replace(/Private attachment context for this turn\.[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(clean || 'No task summary was available.', 2200);
}

export function taskCommunicationsForNode(node = {}, communications = []) {
  return (communications || []).filter((item) => {
    if (item.fromAgentId === node.agentId || item.toAgentId === node.agentId) return true;
    return (item.references || []).some((reference) => reference.taskNodeId === node.id);
  });
}
