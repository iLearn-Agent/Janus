import { agentInstanceSequenceLabel } from '../../../shared/agentInstanceNaming.js';
import { state } from '../state.js';
import { escapeHtml } from './format.js';

const GENERALIST_AVATAR_URL = '../../assets/system_agents/general_agent/avatar.png';

const FIXED_AGENT_LABELS = {
  general_agent: 'G',
  secretary_agent: '✦',
  private_assistant: '私助',
  ppt: 'PD',
};

const FIXED_AGENT_TONES = {
  general_agent: 0,
  secretary_agent: 1,
  private_assistant: 2,
  ppt: 3,
};

export function agentAvatarLabel(agentId = '', displayName = '') {
  const cleanId = String(agentId || '').trim();
  if (FIXED_AGENT_LABELS[cleanId]) return FIXED_AGENT_LABELS[cleanId];
  const cleanName = String(displayName || cleanId || 'A').trim();
  const chinese = [...cleanName].filter((character) => /[\u3400-\u9fff]/u.test(character));
  if (chinese.length) return chinese.slice(0, 2).join('');
  const initials = cleanName.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2);
  return (initials || cleanName.slice(0, 2) || 'A').toUpperCase();
}

export function agentAvatarImageUrl(agentId = '') {
  return String(agentId || '').trim() === 'general_agent' ? GENERALIST_AVATAR_URL : '';
}

export function renderAgentAvatarContent(agentId = '', displayName = '') {
  const imageUrl = agentAvatarImageUrl(agentId);
  if (imageUrl) {
    return `<img class="agent-avatar-image" src="${imageUrl}" alt="" decoding="async" draggable="false" />`;
  }
  return escapeHtml(agentAvatarLabel(agentId, displayName));
}

export function agentAvatarTone(agentId = '', displayName = '') {
  const cleanId = String(agentId || '').trim();
  if (Number.isInteger(FIXED_AGENT_TONES[cleanId])) return FIXED_AGENT_TONES[cleanId];
  const source = cleanId || String(displayName || 'agent');
  let hash = 0;
  for (const character of source) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return hash % 6;
}

export function employeeRouteEligibleForChat(employee = {}) {
  const employmentState = String(employee.employmentState || employee.employment_state || '');
  const pendingTargetState = String(employee.pendingTargetState || employee.pending_target_state || '');
  const authorityState = String(employee.authorityState || employee.authority_state || '');
  if (authorityState === 'pending' && pendingTargetState === 'active' && employmentState !== 'conflict') {
    return employee.routeEligible !== false && employee.route_eligible !== false;
  }
  if (['inactive', 'conflict'].includes(employmentState)) return false;
  if (pendingTargetState === 'inactive') return false;
  return employee.routeEligible !== false && employee.route_eligible !== false;
}

export function agentInstanceDisplayNameForUi(employee = {}, fallback = '') {
  const familyId = String(employee.agentFamilyId || employee.agent_family_id || '').trim();
  const raw = String(
    employee.displayName || employee.display_name || fallback || employee.family?.name || familyId || 'Agent',
  ).normalize('NFKC').trim() || 'Agent';
  if (familyId !== 'ppt') return raw;
  const legacyDefault = raw.match(/^(?:PPT\s*(?:通用风格\s*)?Agent|PPT\s*Designer)(?:\s+([A-Z]+|\d+))?$/iu);
  if (!legacyDefault) return raw;
  const sequence = Math.max(0, Math.floor(Number(employee.familyInstanceSeq ?? employee.family_instance_seq ?? 0) || 0));
  const suffix = sequence ? agentInstanceSequenceLabel(sequence) : String(legacyDefault[1] || '').toUpperCase();
  const baseName = state.languageMode === 'en' ? 'PPT Designer' : 'PPT Agent';
  return `${baseName}${suffix ? ` ${suffix}` : ''}`;
}
