function clean(value) {
  return String(value || '').trim();
}

function normalize(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function firstClean(...values) {
  return values.map(clean).find(Boolean) || '';
}

export function resolveSessionAgentIdentity(session = {}, {
  employees = [],
  settings = [],
  agents = [],
  agentName = (agent) => agent?.name || agent?.id || '',
} = {}) {
  const instanceId = clean(session.agentInstanceId || session.agent_instance_id);
  const employee = instanceId ? (employees || []).find((item) => clean(item?.id) === instanceId) || null : null;
  const setting = instanceId ? (settings || []).find((item) => clean(item?.id) === instanceId) || null : null;
  const agentId = clean(
    session.agentId
    || session.agent_id
    || employee?.agentFamilyId
    || employee?.agent_family_id
    || setting?.agentFamilyId
    || setting?.agent_family_id,
  );
  const agent = agentId ? (agents || []).find((item) => clean(item?.id) === agentId) || null : null;
  if (!employee && !setting && !agent && !agentId && !instanceId) return null;

  const familyName = firstClean(
    employee?.family?.name
    || employee?.familyName,
    employee?.family_name,
    setting?.family?.name || setting?.familyName,
    setting?.family_name,
    agent?.name,
  );
  const configuredAgentName = clean(agent ? agentName(agent) : '');
  const displayName = firstClean(
    employee?.displayName,
    employee?.display_name,
    setting?.displayName,
    setting?.display_name,
  )
    || familyName
    || configuredAgentName
    || agentId
    || instanceId;

  return {
    displayName,
    note: firstClean(employee?.note, setting?.note),
    familyName,
    agentName: configuredAgentName,
    agentId,
    instanceId,
  };
}

export function sessionMatchesAgentQuery(session = {}, query = '', options = {}) {
  const identity = resolveSessionAgentIdentity(session, options);
  const normalizedQuery = normalize(query);
  if (!identity || !normalizedQuery) return false;
  const searchable = normalize([
    identity.displayName,
    identity.note,
    identity.familyName,
    identity.agentName,
    identity.agentId,
    identity.instanceId,
    session.title,
  ].filter(Boolean).join(' '));
  const parts = normalizedQuery.split(' ').filter(Boolean);
  return searchable.includes(normalizedQuery)
    || (parts.length > 0 && parts.every((part) => searchable.includes(part)));
}
