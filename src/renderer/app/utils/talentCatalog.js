export function visibleTalentFamilyIds(overview = null) {
  if (!overview || !Array.isArray(overview.recruitableFamilies)) return null;
  return new Set(overview.recruitableFamilies
    .map((item) => String(item?.id || item?.agentFamilyId || '').trim())
    .filter(Boolean));
}

export function talentFamilyVisible(familyId = '', visibleFamilyIds = null) {
  if (!(visibleFamilyIds instanceof Set)) return true;
  return visibleFamilyIds.has(String(familyId || '').trim());
}
