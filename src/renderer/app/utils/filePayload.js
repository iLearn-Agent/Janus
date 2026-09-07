import { escapeAttr } from './format.js';

export function normalizeFilePayload(file = {}) {
  const name = file.name || file.filename || 'file';
  const filename = file.filename || name;
  const fileUrl = file.fileUrl || file.file_url || file.previewUrl || file.preview_url || file.downloadUrl || file.download_url || file.url || '';
  const kind = Object.hasOwn(file, 'kind') || Object.hasOwn(file, 'visualKind')
    ? String(file.kind ?? file.visualKind ?? '')
    : inferFileKind(filename, file.content_type || file.type || '');
  return {
    id: file.id || file.remote_file_id || file.remoteFileId || '',
    remote_file_id: file.remote_file_id || file.remoteFileId || '',
    remote_file_kind: file.remote_file_kind || file.remoteFileKind || '',
    group_id: file.group_id || file.groupId || '',
    messageId: file.messageId || file.message_id || '',
    sessionId: file.sessionId || file.session_id || '',
    projectId: file.projectId || file.project_id || '',
    sha256: file.sha256 || '',
    kind,
    name,
    filename,
    path: file.path || '',
    relative_path: file.relative_path || file.relativePath || file.workspace_relative_path || file.workspaceRelativePath || '',
    content_type: file.content_type || file.type || '',
    type: file.type || file.content_type || '',
    size: Number(file.size || 0),
    fileUrl,
    file_url: file.file_url || fileUrl,
    preview_url: file.preview_url || file.previewUrl || fileUrl,
    download_url: file.download_url || file.downloadUrl || fileUrl,
    render_url: file.render_url || '',
    office_pdf_url: file.office_pdf_url || '',
    preview_render_mode: file.preview_render_mode || file.previewRenderMode || '',
    cover_url: file.cover_url || file.coverUrl || file.deck_cover_url || '',
    slide_image_urls: Array.isArray(file.slide_image_urls || file.slideImageUrls || file.deck_slide_urls)
      ? (file.slide_image_urls || file.slideImageUrls || file.deck_slide_urls).filter(Boolean)
      : [],
  };
}

export function filePayloadAttr(file = {}) {
  return escapeAttr(encodeURIComponent(JSON.stringify(normalizeFilePayload(file))));
}


function inferFileKind(filename = '', contentType = '') {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic', 'heif'].includes(ext) || String(contentType || '').startsWith('image/')) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return ext;
  if (['xls', 'xlsx', 'csv', 'tsv'].includes(ext)) return ext;
  if (['ppt', 'pptx'].includes(ext)) return ext;
  if (['txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'toml'].includes(ext)) return 'text';
  if (['js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'go', 'rs'].includes(ext)) return 'code';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'archive';
  if (['exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso'].includes(ext)) return 'installer';
  return '';
}
