export function updateChatGroupMemberSelection({
  memberIds = [], selectedIds = [], anchorId = '', currentId = '', checked = false, shiftKey = false,
} = {}) {
  const orderedIds = [...new Set(memberIds.map((id) => String(id || '').trim()).filter(Boolean))];
  const currentIndex = orderedIds.indexOf(String(currentId || '').trim());
  if (currentIndex < 0) return [...new Set(selectedIds)];
  const anchorIndex = shiftKey ? orderedIds.indexOf(String(anchorId || '').trim()) : -1;
  const affectedIds = anchorIndex >= 0
    ? orderedIds.slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1)
    : [orderedIds[currentIndex]];
  const selected = new Set(selectedIds);
  affectedIds.forEach((id) => checked ? selected.add(id) : selected.delete(id));
  return [...selected];
}
