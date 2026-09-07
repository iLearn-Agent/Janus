export const RETIRED_DEPARTMENT_IDS = Object.freeze([
  'research_department',
  'project_department',
  'paper_department',
  'grant_proposal_department',
]);

export const LEGACY_CHAT_DEPARTMENT_IDS = Object.freeze([
  ...RETIRED_DEPARTMENT_IDS,
  'test_department',
]);

const retiredDepartmentIdSet = new Set(RETIRED_DEPARTMENT_IDS);
const legacyChatDepartmentIdSet = new Set(LEGACY_CHAT_DEPARTMENT_IDS);

export function isRetiredDepartmentId(value = '') {
  return retiredDepartmentIdSet.has(String(value || '').trim());
}

export function isLegacyChatDepartmentId(value = '') {
  return legacyChatDepartmentIdSet.has(String(value || '').trim());
}
