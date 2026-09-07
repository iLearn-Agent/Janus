export const GENERAL_AGENT_ID = 'general_agent';

export const LEGACY_GENERAL_AGENT_IDS = Object.freeze([
  'general_agent_1',
  'general_agent_2',
  'general_agent_3',
]);

export function canonicalGeneralAgentId(agentId = '') {
  const id = String(agentId || '').trim();
  return isLegacyGeneralAgentId(id) ? GENERAL_AGENT_ID : id;
}

export function isLegacyGeneralAgentId(agentId = '') {
  return /^general_agent_[1-9][0-9]*$/u.test(String(agentId || '').trim());
}
