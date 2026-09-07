export function findPersistedRewriteMessage(message = null, candidates = [], {
  textForMessage = (item) => String(item?.content || ''),
} = {}) {
  const sourceText = textForMessage(message);
  if (!message || !sourceText) return null;
  return [...(Array.isArray(candidates) ? candidates : [])].reverse().find((candidate) => (
    candidate?.role === 'user'
    && !String(candidate?.id || '').startsWith('local-')
    && textForMessage(candidate) === sourceText
  )) || null;
}
