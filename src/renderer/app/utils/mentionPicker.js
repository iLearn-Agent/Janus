function trailingMentionQuery(content = '') {
  const match = String(content || '').match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}

export function socialMentionTriggerRemoved(previousContent = '', nextContent = '') {
  return trailingMentionQuery(previousContent) !== null && trailingMentionQuery(nextContent) === null;
}
