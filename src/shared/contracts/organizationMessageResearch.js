export const ORGANIZATION_MESSAGE_RESEARCH_CAPABILITY = 'organization-message-research-v1';
export const ORGANIZATION_RESEARCH_CONTEXT_TTL_MS = 30 * 60 * 1000;
export const ORGANIZATION_RESEARCH_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
export const ORGANIZATION_RESEARCH_MAX_HITS = 24;
export const ORGANIZATION_RESEARCH_MAX_CONVERSATIONS = 8;
export const ORGANIZATION_RESEARCH_CONTEXT_RADIUS = 10;

const SOURCE_KINDS = new Set(['workspace_message', 'direct_message', 'chat_group', 'collaboration_group']);

export function normalizeOrganizationResearchDecision(value = {}) {
  const source = value?.organizationResearch && typeof value.organizationResearch === 'object'
    ? value.organizationResearch : value;
  return {
    requiresOrganizationResearch: source.requiresOrganizationResearch === true,
    continuesResearchTopic: source.continuesResearchTopic === true,
    filters: normalizeOrganizationResearchFilters(source.filters || source.organizationResearchFilters || {}),
  };
}

export function normalizeOrganizationResearchFilters(value = {}) {
  const sourceKinds = [...new Set((Array.isArray(value.sourceKinds) ? value.sourceKinds : [])
    .map((item) => String(item || '').trim()).filter((item) => SOURCE_KINDS.has(item)))];
  return {
    personIds: [...new Set((Array.isArray(value.personIds) ? value.personIds : [])
      .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 20),
    conversationIds: [...new Set((Array.isArray(value.conversationIds) ? value.conversationIds : [])
      .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 20),
    sourceKinds,
    after: validIso(value.after),
    before: validIso(value.before),
  };
}

export function organizationResearchCitationId(document = {}) {
  return `orgmsg:${String(document.organizationId || '')}:${String(document.sourceKind || '')}:${String(document.sourceMessageId || document.messageId || '')}:${Math.max(1, Number(document.revision || 1))}`;
}

export function validateOrganizationResearchAnswer(value = {}, allowedCitationIds = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError('Research answer must be an object.');
  const answer = String(value.answer || '').trim();
  if (!answer) throw contractError('Research answer is missing answer text.');
  const allowed = new Set((Array.isArray(allowedCitationIds) ? allowedCitationIds : []).map(String));
  const citationIds = [...new Set((Array.isArray(value.citationIds) ? value.citationIds : [])
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const invalid = citationIds.filter((id) => !allowed.has(id));
  if (invalid.length) throw contractError(`Research answer contains invalid citations: ${invalid.join(', ')}`);
  return { answer, citationIds, insufficientEvidence: value.insufficientEvidence === true };
}

function validIso(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function contractError(message) {
  const error = new Error(message);
  error.code = 'organization_research_contract_invalid';
  return error;
}
