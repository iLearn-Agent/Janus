export function normalizeLocalFileMatchKey(value = '') {
  let normalized = parseLocalFileReference(value).path;
  try { normalized = decodeURIComponent(normalized); } catch {}
  return normalized
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/^\/([a-z]:\/)/i, '$1')
    .replace(/^\.\//, '')
    .toLocaleLowerCase();
}

export function parseLocalFileReference(value = '') {
  let target = String(value || '').trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  const titled = target.match(/^(.*?)\s+["'][^"']*["']$/);
  if (titled) target = titled[1].trim();

  let line = 0;
  let column = 0;
  const location = target.match(/:(\d+)(?::(\d+))?$/);
  if (location && !/^[a-z]:\d+$/i.test(target)) {
    line = Number(location[1] || 0);
    column = Number(location[2] || 0);
    target = target.slice(0, -location[0].length);
  }

  const suffixIndex = target.search(/[?#]/);
  const suffix = suffixIndex >= 0 ? target.slice(suffixIndex) : '';
  if (suffixIndex >= 0) target = target.slice(0, suffixIndex);
  return { path: target.trim(), line, column, suffix };
}

export function resolveMessageArtifactLink(rawPath = '', files = []) {
  const target = normalizeLocalFileMatchKey(rawPath);
  if (!target) return null;
  const referencePath = parseLocalFileReference(rawPath).path;
  const absoluteTarget = /^(?:file:\/\/|[a-z]:[\\/]|\/|\\\\)/i.test(referencePath);
  const candidates = new Map();
  for (const file of files) {
    const identity = String(file?.path || file?.relative_path || file?.relativePath
      || file?.workspace_relative_path || file?.workspaceRelativePath || file?.name || file?.filename || '').trim();
    if (identity && !candidates.has(identity)) candidates.set(identity, file);
  }
  const scored = [...candidates.values()].map((file) => {
    const filePath = normalizeLocalFileMatchKey(file.path || '');
    const relativePath = normalizeLocalFileMatchKey(file.relative_path || file.relativePath
      || file.workspace_relative_path || file.workspaceRelativePath || '');
    const filename = normalizeLocalFileMatchKey(file.name || file.filename || localPathBasename(file.path || ''));
    let score = 0;
    if (filePath && filePath === target) score = 4;
    else if (!absoluteTarget && relativePath && (relativePath === target || relativePath.endsWith(`/${target}`))) score = 3;
    else if (!absoluteTarget && filename && filename === localPathBasename(target)) score = 2;
    return { file, score };
  }).filter((item) => item.score > 0);
  if (!scored.length) return null;
  const bestScore = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === bestScore);
  return best.length === 1 ? best[0].file : null;
}

export function resolveLinkedMessageArtifact(rawPath = '', { messageId = '', messages = [], files = [] } = {}) {
  const candidates = [...(Array.isArray(files) ? files : [])];
  const cleanMessageId = String(messageId || '').trim();
  for (const message of Array.isArray(messages) ? messages : []) {
    const metadata = message?.metadata || {};
    if (String(metadata.candidateMessageId || metadata.candidate_message_id || '').trim() !== cleanMessageId) continue;
    if (Array.isArray(metadata.attachments)) candidates.push(...metadata.attachments);
  }
  return resolveMessageArtifactLink(rawPath, candidates);
}

function localPathBasename(value = '') {
  return String(value || '').replace(/\\/g, '/').split('/').pop() || '';
}
