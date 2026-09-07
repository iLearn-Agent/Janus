export const AGENT_CAPABILITY_CATALOG_VERSION = 'agent_capability_catalog_v1';

export function buildAgentCapabilityCatalog({
  store,
  org,
  organization = null,
  employeeInstances = null,
  leadership = null,
  performance = null,
  availability = null,
  userId = '',
  performanceForAgent = null,
  leadershipForAgent = null,
  now = new Date(),
} = {}) {
  const currentDate = validDate(now);
  if (!store && (organization || employeeInstances)) {
    return buildCatalogFromContractInputs({
      organization: organization || org,
      employeeInstances,
      leadership,
      performance,
      availability,
      now: currentDate,
    });
  }
  const entries = (store?.activeEmployeeAgentsForUser?.({ userId }) || []).map((employee) => {
    const registeredAgent = safeCall(() => org?.agent?.(employee.agentFamilyId), null);
    const agent = registeredAgent || employee.family || {};
    const departmentId = agent.departmentId || employee.family?.departmentId || '';
    const department = safeCall(() => org?.department?.(departmentId), null) || {};
    const queue = safeArray(safeCall(() => store?.listAgentWorkQueue?.({
      agentInstanceId: employee.id,
      statuses: ['queued', 'running'],
      limit: 100,
    }), []));
    const skillResolution = safeCall(() => store?.resolveEffectiveSkill?.({ agentInstanceId: employee.id }), null);
    const sourceSkill = String(registeredAgent ? safeCall(() => org?.readSkill?.(registeredAgent), '') : '').trim();
    const effectiveSkill = String(skillResolution?.effectiveSkill || sourceSkill).trim();
    const skillDescription = extractSkillDescription(sourceSkill) || extractSkillDescription(effectiveSkill);
    const personalOverlay = String(skillResolution?.personalSkillVersion?.overlayText || '').trim();
    const personalSpecialization = compactPersonalSpecialization(personalOverlay);
    const attachedSkills = safeArray(safeCall(() => store?.resolveAttachedSkills?.({
      ownerUserId: userId,
      departmentId,
      agentFamilyId: employee.agentFamilyId,
      agentInstanceId: employee.id,
    }), []));
    const performance = typeof performanceForAgent === 'function'
      ? safeCall(() => performanceForAgent(employee.id), null)
      : null;
    const leadership = typeof leadershipForAgent === 'function'
      ? safeCall(() => leadershipForAgent(employee.id), null)
      : null;
    const leadershipLevel = normalizeLeadershipLevel(leadership?.level);
    const leadershipAgeMs = currentDate.getTime() - Date.parse(leadership?.projectionUpdatedAt || '');
    const leadershipStale = !Number.isFinite(leadershipAgeMs) || leadershipAgeMs > 7 * 86400000;
    const runningWork = queue.find((item) => item.status === 'running')?.workId || '';
    const availability = store?.getAgentAvailability?.({ userId, agentInstanceId: employee.id }) || null;
    const responsibilities = String(registeredAgent ? registeredAgent.description : employee.family?.description || '').trim();
    const capabilities = cleanStringArray([
      ...safeArray(agent.skills || employee.family?.skills),
      ...attachedSkills.map((skill) => skill.name),
    ], 24, 180);
    const attachedSkillSummary = attachedSkills.map((skill) => `${skill.name}: ${skill.description || ''}`).join('\n');

    return {
      agentId: String(employee.agentFamilyId || agent.id || '').trim(),
      agentInstanceId: String(employee.id || '').trim(),
      name: String(employee.displayName || agent.name || employee.family?.name || employee.agentFamilyId || '').trim(),
      displayName: String(employee.displayName || '').trim(),
      familyName: String(agent.name || employee.family?.name || employee.agentFamilyId || '').trim(),
      responsibilities,
      skillDescription,
      personalSpecialization,
      attachedSkills: attachedSkills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description || '' })),
      capabilities,
      departmentId,
      departmentName: String(department.name || departmentId || 'general').trim(),
      role: String(agent.lifecycleRole || agent.role || employee.family?.role || 'agent').trim(),
      rank: String(agent.rank || employee.family?.rank || 'specialist').trim(),
      employmentState: String(employee.employmentState || 'active').trim(),
      lifecycleStatus: String(agent.lifecycleStatus || agent.lifecycle?.status || 'active').trim(),
      routingState: String(agent.routingState || agent.lifecycle?.routingState || 'active').trim(),
      routeEligible: employee.routeEligible !== false && agent.routable !== false,
      performanceLevel: normalizePerformanceLevel(performance?.level),
      provisional: performance ? Boolean(performance.provisional) : true,
      leadershipLevel,
      leadershipScore: finiteNumber(leadership?.score, { min: 0, max: 100, fallback: 0 }),
      leadershipProvisional: leadership ? Boolean(leadership.provisional) : true,
      leadershipStatus: leadershipStale && leadershipLevel !== 'L0'
        ? 'inactive'
        : normalizeLeadershipStatus(leadership?.status),
      leadershipTrialApproved: !leadershipStale && Boolean(leadership?.approvedTrial),
      leadershipTrialActionId: String(leadership?.approvedTrial?.id || ''),
      leadershipTrialRole: String(leadership?.approvedTrial?.evidence?.role || ''),
      leadershipActiveTaskGroups: safeArray(safeCall(
        () => store?.listActiveWorkLeadershipAssignments?.({ agentInstanceId: employee.id }),
        [],
      )).length,
      leadershipProjectionUpdatedAt: String(leadership?.projectionUpdatedAt || ''),
      status: availability?.availability === 'working' ? 'busy' : 'available',
      availability: availability?.availability || (queue.length ? 'working' : 'idle'),
      workState: availability?.workState || queue[0]?.status || '',
      runningWork,
      queueDepth: queue.filter((item) => item.status === 'queued').length,
      effectiveSkill: compactEffectiveSkillSummary({
        responsibilities,
        skillDescription,
        capabilities,
        personalOverlay: personalSpecialization,
        effectiveSkill,
        attachedSkillSummary,
      }),
    };
  });
  const catalog = {
    version: AGENT_CAPABILITY_CATALOG_VERSION,
    generatedAt: currentDate.toISOString(),
    entries,
    diagnostics: [],
  };
  catalog.diagnostics = validateAgentCapabilityCatalog(catalog);
  return catalog;
}

function buildCatalogFromContractInputs({
  organization = {}, employeeInstances = [], leadership = null, performance = null, availability = null, now,
} = {}) {
  const organizationValue = typeof organization?.list === 'function' ? organization.list() : organization || {};
  const agents = Array.isArray(organizationValue.agents) ? organizationValue.agents : [];
  const departments = Array.isArray(organizationValue.departments) ? organizationValue.departments : [];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const departmentById = new Map(departments.map((department) => [department.id, department]));
  const entries = (Array.isArray(employeeInstances) ? employeeInstances : []).map((employee) => {
    const agentId = String(employee.agentFamilyId || employee.agent_family_id || employee.agentId || '').trim();
    const agent = agentById.get(agentId) || employee.family || {};
    const departmentId = String(employee.departmentId || agent.departmentId || employee.family?.departmentId || '').trim();
    const performanceValue = projectionValue(performance, employee.id);
    const leadershipValue = projectionValue(leadership, employee.id);
    const availabilityValue = projectionValue(availability, employee.id) || {};
    const responsibilities = String(agent.description || employee.responsibilities || employee.family?.description || '').trim();
    const skillDescription = String(employee.skillDescription || employee.skillSummary || agent.skillDescription || '').trim();
    const capabilities = cleanStringArray(employee.capabilities || agent.skills || employee.family?.skills, 24, 180);
    return {
      agentId,
      agentInstanceId: String(employee.id || employee.agentInstanceId || '').trim(),
      name: String(employee.displayName || employee.name || agent.name || employee.family?.name || agentId).trim(),
      displayName: String(employee.displayName || '').trim(),
      familyName: String(agent.name || employee.family?.name || agentId).trim(),
      responsibilities,
      skillDescription,
      personalSpecialization: String(employee.personalSpecialization || '').trim(),
      capabilities,
      departmentId,
      departmentName: String(departmentById.get(departmentId)?.name || departmentId || 'general').trim(),
      role: String(agent.lifecycleRole || agent.role || employee.role || 'agent').trim(),
      rank: String(agent.rank || employee.rank || 'specialist').trim(),
      employmentState: String(employee.employmentState || employee.employment_state || 'active').trim(),
      lifecycleStatus: String(agent.lifecycleStatus || employee.lifecycleStatus || 'active').trim(),
      routingState: String(agent.routingState || employee.routingState || 'active').trim(),
      routeEligible: employee.routeEligible !== false && agent.routable !== false,
      performanceLevel: normalizePerformanceLevel(performanceValue?.level || employee.performanceLevel),
      provisional: performanceValue ? performanceValue.provisional !== false : employee.provisional !== false,
      leadershipLevel: normalizeLeadershipLevel(leadershipValue?.level || employee.leadershipLevel),
      leadershipScore: finiteNumber(leadershipValue?.score ?? employee.leadershipScore, { min: 0, max: 100, fallback: 0 }),
      leadershipProvisional: leadershipValue ? leadershipValue.provisional !== false : employee.leadershipProvisional !== false,
      leadershipStatus: normalizeLeadershipStatus(leadershipValue?.status || employee.leadershipStatus),
      leadershipTrialApproved: Boolean(leadershipValue?.approvedTrial || employee.leadershipTrialApproved),
      leadershipTrialActionId: String(leadershipValue?.approvedTrial?.id || employee.leadershipTrialActionId || ''),
      leadershipTrialRole: String(leadershipValue?.approvedTrial?.evidence?.role || employee.leadershipTrialRole || ''),
      leadershipActiveTaskGroups: Math.max(0, Number(employee.leadershipActiveTaskGroups || 0)),
      leadershipProjectionUpdatedAt: String(leadershipValue?.projectionUpdatedAt || employee.leadershipProjectionUpdatedAt || ''),
      status: availabilityValue.availability === 'working' ? 'busy' : 'available',
      availability: availabilityValue.availability === 'working' ? 'working' : 'idle',
      workState: String(availabilityValue.workState || ''),
      runningWork: String(availabilityValue.currentWork?.title || availabilityValue.currentWork || ''),
      queueDepth: Math.max(0, Number(availabilityValue.queueDepth || employee.queueDepth || 0)),
      effectiveSkill: compactEffectiveSkillSummary({ responsibilities, skillDescription, capabilities,
        personalOverlay: employee.personalSpecialization || '', effectiveSkill: employee.effectiveSkill || '' }),
    };
  });
  const catalog = { version: AGENT_CAPABILITY_CATALOG_VERSION, generatedAt: now.toISOString(), entries, diagnostics: [] };
  catalog.diagnostics = validateAgentCapabilityCatalog(catalog);
  return catalog;
}

function projectionValue(source, id) {
  if (typeof source === 'function') return safeCall(() => source(id), null);
  if (source instanceof Map) return source.get(id) || null;
  if (source && typeof source === 'object') return source[id] || null;
  return null;
}

export function validateAgentCapabilityCatalog(catalog = {}, { throwOnError = false } = {}) {
  const diagnostics = [];
  const seenInstances = new Set();
  for (const entry of Array.isArray(catalog.entries) ? catalog.entries : []) {
    if (!entry.agentId || !entry.agentInstanceId) {
      diagnostics.push(diagnostic('agent_identity_missing', entry, 'Agent id and instance id are required.'));
    }
    if (entry.agentInstanceId && seenInstances.has(entry.agentInstanceId)) {
      diagnostics.push(diagnostic('agent_instance_duplicate', entry, 'Agent instance appears more than once.'));
    }
    seenInstances.add(entry.agentInstanceId);
    if (!String(entry.responsibilities || '').trim()) {
      diagnostics.push(diagnostic('agent_responsibilities_missing', entry, 'Agent responsibility description is required for routing.'));
    }
    if (!String(entry.skillDescription || '').trim()) {
      diagnostics.push(diagnostic(
        'agent_skill_description_missing',
        entry,
        'SKILL.md frontmatter description is missing; routing will use agent responsibilities and capability tags.',
        'warning',
      ));
    }
    if (!entry.departmentId) {
      diagnostics.push(diagnostic('agent_department_missing', entry, 'Agent department is required for routing.'));
    }
    if (entry.routeEligible === false) {
      diagnostics.push(diagnostic('agent_not_route_eligible', entry, 'Agent is not currently eligible for automatic routing.'));
    }
  }
  const errors = diagnostics.filter((item) => item.severity === 'error');
  if (throwOnError && errors.length) {
    const error = new Error(`Agent capability catalog validation failed: ${errors.map((item) => `${item.code}:${item.agent}`).join(', ')}`);
    error.code = 'agent_capability_catalog_invalid';
    error.diagnostics = diagnostics;
    throw error;
  }
  return diagnostics;
}

export function capabilityCatalogPlannerCandidates(catalog = {}) {
  return (Array.isArray(catalog.entries) ? catalog.entries : [])
    .filter((entry) => !catalogEntryHasError(catalog, entry))
    .map((entry) => ({ ...entry }));
}

export function renderUBuddyCapabilityCatalogPrompt(catalog = {}) {
  const agents = (Array.isArray(catalog.entries) ? catalog.entries : [])
    .filter((entry) => !catalogEntryHasError(catalog, entry))
    .map((entry) => ({
      agentId: entry.agentId,
      agentInstanceId: entry.agentInstanceId,
      name: entry.name,
      responsibilities: clip(entry.responsibilities, 360),
      skill: clip(entry.skillDescription, 360),
      specialization: clip(entry.personalSpecialization, 360),
      capabilities: cleanStringArray(entry.capabilities, 16, 100),
      attachedSkills: safeArray(entry.attachedSkills).map((skill) => ({
        id: skill.id,
        name: clip(skill.name, 100),
        description: clip(skill.description, 240),
      })),
      department: { id: entry.departmentId, name: entry.departmentName },
      role: entry.role,
      rank: entry.rank,
      leadership: { level: entry.leadershipLevel, status: entry.leadershipStatus },
      work: { level: entry.performanceLevel, provisional: entry.provisional },
      current: {
        employment: entry.employmentState,
        lifecycle: entry.lifecycleStatus,
        routing: entry.routingState,
        availability: entry.status,
        queueDepth: entry.queueDepth,
      },
    }));
  return JSON.stringify({
    version: catalog.version || AGENT_CAPABILITY_CATALOG_VERSION,
    generatedAt: catalog.generatedAt || '',
    agents,
    diagnostics: (catalog.diagnostics || []).map((item) => ({
      severity: item.severity,
      code: item.code,
      agent: item.agent,
      agentInstanceId: item.agentInstanceId,
    })),
  });
}

function extractSkillDescription(skill = '') {
  const frontmatter = String(skill || '').match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const lines = frontmatter.split(/\r?\n/);
  const index = lines.findIndex((item) => /^description\s*:/i.test(item));
  if (index < 0) return '';
  const raw = String(lines[index]).replace(/^description\s*:\s*/i, '').trim();
  if (!['|', '>', '|-', '>-', '|+', '>+'].includes(raw)) {
    return raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  const continuation = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (!/^\s+/.test(lines[cursor])) break;
    continuation.push(lines[cursor].trim());
  }
  return continuation.filter(Boolean).join(raw.startsWith('>') ? ' ' : '\n').trim();
}

function compactEffectiveSkillSummary({ responsibilities = '', skillDescription = '', capabilities = [], personalOverlay = '', effectiveSkill = '', attachedSkillSummary = '' } = {}) {
  const base = [
    responsibilities,
    skillDescription && skillDescription !== responsibilities ? `Skill: ${skillDescription}` : '',
    capabilities.length ? `Capabilities: ${capabilities.join(', ')}` : '',
  ].filter(Boolean).join('\n').slice(0, 900);
  const specialization = personalOverlay
    ? `Personal instance specialization:\n${personalOverlay.slice(0, 600)}`
    : String(effectiveSkill || '').slice(0, 600);
  const attached = attachedSkillSummary ? `Assigned Skills:\n${attachedSkillSummary.slice(0, 600)}` : '';
  return [base, specialization, attached].filter(Boolean).join('\n\n').slice(0, 1600);
}

function compactPersonalSpecialization(overlay = '') {
  return String(overlay || '')
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function catalogEntryHasError(catalog, entry) {
  return (catalog.diagnostics || []).some((item) => {
    if (item.severity !== 'error') return false;
    if (item.agentInstanceId) return item.agentInstanceId === entry.agentInstanceId;
    return !entry.agentInstanceId && item.agent === entry.agentId;
  });
}

function normalizePerformanceLevel(value) {
  return /^P(?:10|[1-9])$/.test(String(value || '')) ? String(value) : 'P1';
}

function normalizeLeadershipLevel(value) {
  return /^L[0-3]$/.test(String(value || '')) ? String(value) : 'L0';
}

function normalizeLeadershipStatus(value) {
  return ['active', 'frozen', 'inactive'].includes(String(value || '')) ? String(value) : 'active';
}

function cleanStringArray(value, limit, itemLimit) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim().slice(0, itemLimit)).filter(Boolean))].slice(0, limit);
}

function finiteNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, fallback = 0 } = {}) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeCall(callback, fallback) {
  try {
    const value = callback();
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function diagnostic(code, entry, message, severity = 'error') {
  return {
    code,
    agent: String(entry?.agentId || 'unknown_agent'),
    agentInstanceId: String(entry?.agentInstanceId || ''),
    severity,
    message,
  };
}

function clip(value, limit) {
  const text = String(value || '').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}
