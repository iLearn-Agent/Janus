const REFERENCE_KINDS = new Set(['file', 'directory']);

export function normalizeProjectFileReference(value = {}, { requirePicker = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const referenceKind = String(value.referenceKind || value.reference_kind || value.kind || 'file').trim().toLowerCase();
  const projectId = String(value.projectId || value.project_id || '').trim();
  const relativePath = normalizeRelativeProjectPath(value.relativePath || value.relative_path || '');
  const referenceId = String(value.referenceId || value.reference_id || value.id || '').trim();
  const source = String(value.source || '').trim().toLowerCase();
  if (!REFERENCE_KINDS.has(referenceKind) || !projectId || !relativePath || !referenceId) return null;
  if (requirePicker && source !== 'picker') return null;
  return {
    referenceId,
    referenceKind,
    projectId,
    relativePath,
    name: String(value.name || relativePath.split('/').at(-1) || relativePath).trim(),
    contentType: String(value.contentType || value.content_type || '').trim(),
    sizeBytes: Math.max(0, Number(value.sizeBytes || value.size_bytes || 0) || 0),
    contentHash: String(value.contentHash || value.content_hash || value.sha256 || '').trim().toLowerCase(),
    modifiedAt: String(value.modifiedAt || value.modified_at || '').trim(),
    source: source || 'picker',
    memoryId: String(value.memoryId || value.memory_id || '').trim(),
    contextSpaceId: String(value.contextSpaceId || value.context_space_id || '').trim(),
  };
}

export function normalizeProjectFileReferences(values = [], options = {}) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const reference = normalizeProjectFileReference(value, options);
    if (!reference) continue;
    const key = `${reference.projectId}:${reference.referenceKind}:${reference.relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

export function normalizeRelativeProjectPath(value = '') {
  const text = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!text || text.includes('\0')) return '';
  const segments = text.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return segments.join('/');
}
