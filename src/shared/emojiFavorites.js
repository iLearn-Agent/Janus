export const EMOJI_FAVORITES_MAX = 300;
export const EMOJI_FAVORITE_MAX_BYTES = 2 * 1024 * 1024;
export const EMOJI_FAVORITE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function normalizeEmojiFavorite(item = {}) {
  const source = typeof item === 'string' ? { value: item, kind: 'unicode' } : item || {};
  const value = String(source.value || source.emoji || '').trim();
  const kind = source.kind === 'image' ? 'image' : 'unicode';
  const dataUrlValue = kind === 'image' && value.startsWith('data:image/') ? value : '';
  const sourceUrl = String(source.url || source.previewUrl || source.preview_url || source.render_url || '');
  const url = dataUrlValue || sourceUrl.slice(0, 2_000);
  if (kind === 'unicode' && !value) return null;
  if (kind === 'image' && !value && !source.url && !source.previewUrl && !source.preview_url) return null;
  return {
    id: String(source.id || `emoji_${kind}_${value || Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 200),
    kind,
    value,
    name: String(source.name || source.filename || (kind === 'unicode' ? value : '自定义表情')).slice(0, 180),
    filename: String(source.filename || source.name || '').slice(0, 180),
    contentType: String(source.contentType || source.content_type || '').slice(0, 100),
    size: Math.max(0, Number(source.size || 0) || 0),
    sha256: String(source.sha256 || '').toLowerCase().slice(0, 128),
    url,
    path: String(source.path || '').slice(0, 2_000),
    createdAt: String(source.createdAt || new Date().toISOString()),
  };
}

export function normalizeEmojiFavorites(items = []) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map(normalizeEmojiFavorite).filter((item) => {
    if (!item) return false;
    const key = item.kind === 'image' ? (item.sha256 || `${item.name}:${item.size}`) : item.value;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, EMOJI_FAVORITES_MAX);
}

export function emojiFavoriteKey(item = {}) {
  return item.kind === 'image' ? (item.sha256 || `${item.name || ''}:${item.size || 0}`) : String(item.value || '').trim();
}

export function isSupportedEmojiFavoriteFile(file = {}) {
  const type = String(file.type || file.contentType || file.content_type || '').toLowerCase();
  const name = String(file.name || file.filename || '').toLowerCase();
  return EMOJI_FAVORITE_TYPES.includes(type) || /\.(png|jpe?g|webp|gif)$/.test(name);
}
