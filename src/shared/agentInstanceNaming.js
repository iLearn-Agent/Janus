import { canonicalGeneralAgentId } from './generalAgents.js';

const CANONICAL_AGENT_FAMILY_NAMES = Object.freeze({
  general_agent: 'Generalist',
  ppt: 'PPT Designer',
});

const LEGACY_AGENT_FAMILY_NAMES = Object.freeze({
  general_agent: ['Generalist', 'General Agent', '通用 Agent'],
  ppt: ['PPT Designer', 'PPT Agent'],
});

const GENERALIST_FAMILY_NAME_PATTERN = /^(?:General Agent|通用 Agent)(?:\s+[0-9]+)?$/iu;
const PPT_DESIGNER_FAMILY_NAME_PATTERN = /^(?:PPT Agent|PPTAgent)$/iu;

export function agentInstanceSequenceLabel(sequence = 1) {
  let value = Math.max(1, Math.floor(Number(sequence) || 1));
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function canonicalAgentFamilyName(agentFamilyId = '', familyName = '') {
  const cleanFamilyId = canonicalGeneralAgentId(agentFamilyId);
  const cleanFamilyName = String(familyName || cleanFamilyId || 'Agent').normalize('NFKC').trim() || 'Agent';
  return CANONICAL_AGENT_FAMILY_NAMES[cleanFamilyId]
    || (GENERALIST_FAMILY_NAME_PATTERN.test(cleanFamilyName) ? 'Generalist' : '')
    || (PPT_DESIGNER_FAMILY_NAME_PATTERN.test(cleanFamilyName) ? 'PPT Designer' : '')
    || cleanFamilyName;
}

export function agentFamilyNameUsesCanonicalTemplate(agentFamilyId = '', familyName = '') {
  const cleanFamilyId = canonicalGeneralAgentId(agentFamilyId);
  const cleanFamilyName = String(familyName || cleanFamilyId || 'Agent').normalize('NFKC').trim() || 'Agent';
  return Object.hasOwn(CANONICAL_AGENT_FAMILY_NAMES, cleanFamilyId)
    || canonicalAgentFamilyName(cleanFamilyId, cleanFamilyName) !== cleanFamilyName;
}

export function defaultAgentInstanceDisplayName(familyName = 'Agent', sequence = 1, agentFamilyId = '') {
  const base = canonicalAgentFamilyName(agentFamilyId, familyName);
  return `${base} ${agentInstanceSequenceLabel(sequence)}`;
}

export function isDefaultAgentInstanceDisplayName(value = '', familyName = 'Agent', agentFamilyId = '', sequence = null) {
  const name = normalizeAgentInstanceDisplayName(value);
  if (!name) return true;
  const cleanFamilyId = String(agentFamilyId || '').trim();
  const expectedLabel = Number.isFinite(Number(sequence)) && Number(sequence) > 0
    ? agentInstanceSequenceLabel(sequence)
    : '';
  const bases = new Set([
    canonicalAgentFamilyName(cleanFamilyId, familyName),
    String(familyName || '').normalize('NFKC').trim(),
    ...(LEGACY_AGENT_FAMILY_NAMES[cleanFamilyId] || []),
  ].filter(Boolean));
  const canonicalFamilyName = canonicalAgentFamilyName(cleanFamilyId, familyName);
  if (canonicalFamilyName === 'Generalist') {
    LEGACY_AGENT_FAMILY_NAMES.general_agent.forEach((base) => bases.add(base));
  } else if (canonicalFamilyName === 'PPT Designer') {
    LEGACY_AGENT_FAMILY_NAMES.ppt.forEach((base) => bases.add(base));
  }
  return [...bases].some((base) => {
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedBase}\\s+${expectedLabel || '[A-Z]+'}$`, 'u').test(name);
  })
    || new RegExp(`^(?:General Agent|通用 Agent)(?:\\s+[0-9]+)?\\s+${expectedLabel || '[A-Z]+'}$`, 'iu').test(name);
}

export function canonicalAgentInstanceDisplayName({
  agentFamilyId = '', familyName = 'Agent', displayName = '', sequence = 1,
} = {}) {
  const currentName = normalizeAgentInstanceDisplayName(displayName);
  return isDefaultAgentInstanceDisplayName(currentName, familyName, agentFamilyId, sequence)
    ? defaultAgentInstanceDisplayName(familyName, sequence, agentFamilyId)
    : currentName;
}

export function repairAgentInstanceProfiles(items = []) {
  const source = Array.isArray(items) ? items : [];
  const groups = new Map();
  for (const item of source) {
    const userId = String(item?.userId || item?.user_id || '').trim();
    const familyId = String(item?.agentFamilyId || item?.agent_family_id || '').trim();
    const id = String(item?.id || '').trim();
    if (!userId || !familyId || !id) continue;
    const key = `${userId}\u001f${familyId}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const repaired = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (
      String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
    let nextSequence = ordered.reduce((maximum, item) => Math.max(
      maximum,
      Math.max(0, Math.floor(Number(item.familyInstanceSeq ?? item.family_instance_seq ?? 0) || 0)),
    ), 0);
    const claimed = new Set();
    for (const item of ordered) {
      const currentSequence = Math.max(0, Math.floor(Number(item.familyInstanceSeq ?? item.family_instance_seq ?? 0) || 0));
      let sequence = currentSequence;
      if (!sequence || claimed.has(sequence)) {
        do { nextSequence += 1; } while (claimed.has(nextSequence));
        sequence = nextSequence;
      }
      claimed.add(sequence);
      const familyId = String(item.agentFamilyId || item.agent_family_id || '').trim();
      const familyName = canonicalAgentFamilyName(familyId, item.familyName || item.family_name || item.agentFamilyName || item.agent_family_name || familyId);
      const currentName = normalizeAgentInstanceDisplayName(item.displayName ?? item.display_name ?? '');
      const generatedName = !currentName
        || isDefaultAgentInstanceDisplayName(currentName, familyName, familyId, currentSequence || 1);
      const displayName = generatedName
        ? defaultAgentInstanceDisplayName(familyName, sequence, familyId)
        : currentName;
      repaired.push({
        ...item,
        familyInstanceSeq: sequence,
        displayName,
        profileChanged: sequence !== currentSequence || displayName !== currentName,
      });
    }
  }
  return repaired;
}

export function compactAgentInstanceProfiles(items = []) {
  const source = Array.isArray(items) ? items : [];
  const groups = new Map();
  const aliases = [];
  for (const item of source) {
    const userId = String(item?.userId || item?.user_id || '').trim();
    const familyId = String(item?.agentFamilyId || item?.agent_family_id || '').trim();
    const id = String(item?.id || '').trim();
    if (!userId || !familyId || !id) continue;
    if (item.isAlias || item.is_alias) {
      aliases.push(item);
      continue;
    }
    const key = `${userId}\u001f${familyId}`;
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  const compacted = aliases.map((item) => ({
    ...item,
    familyInstanceSeq: 0,
    displayName: normalizeAgentInstanceDisplayName(item.displayName ?? item.display_name ?? ''),
    profileChanged: Math.max(0, Math.floor(Number(item.familyInstanceSeq ?? item.family_instance_seq ?? 0) || 0)) !== 0,
  }));
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (
      String(left.recruitedAt || left.recruited_at || left.createdAt || left.created_at || '')
        .localeCompare(String(right.recruitedAt || right.recruited_at || right.createdAt || right.created_at || ''))
      || String(left.id || '').localeCompare(String(right.id || ''))
    ));
    ordered.forEach((item, index) => {
      const sequence = index + 1;
      const currentSequence = Math.max(0, Math.floor(Number(item.familyInstanceSeq ?? item.family_instance_seq ?? 0) || 0));
      const familyId = String(item.agentFamilyId || item.agent_family_id || '').trim();
      const familyName = canonicalAgentFamilyName(
        familyId,
        item.familyName || item.family_name || item.agentFamilyName || item.agent_family_name || familyId,
      );
      const currentName = normalizeAgentInstanceDisplayName(item.displayName ?? item.display_name ?? '');
      const generatedName = !currentName
        || isDefaultAgentInstanceDisplayName(currentName, familyName, familyId, currentSequence || 1);
      const displayName = generatedName
        ? defaultAgentInstanceDisplayName(familyName, sequence, familyId)
        : currentName;
      compacted.push({
        ...item,
        familyInstanceSeq: sequence,
        displayName,
        profileChanged: sequence !== currentSequence || displayName !== currentName,
      });
    });
  }
  return compacted;
}

export function normalizeAgentInstanceDisplayName(value = '') {
  return String(value || '').normalize('NFKC').trim().slice(0, 80);
}

export function normalizeAgentInstanceNote(value = '') {
  return String(value || '').normalize('NFKC').trim().slice(0, 500);
}
