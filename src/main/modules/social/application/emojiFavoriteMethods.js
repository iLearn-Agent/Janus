import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';

function parseJson(value) { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COUNT = 300;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function installEmojiFavoriteMethods(prototype) {
  prototype.listEmojiFavorites = function listEmojiFavorites() {
    const user = this.requireUser();
    return all(this.db, 'SELECT * FROM emoji_favorites WHERE user_id=? ORDER BY sort_order,created_at', [user.id]).map((row) => normalizeFavoriteRow(this, row));
  };
  prototype.listEmojiFavoriteOutbox = function listEmojiFavoriteOutbox() {
    const user = this.requireUser();
    return all(this.db, "SELECT * FROM emoji_favorite_outbox WHERE user_id=? AND status IN ('pending','failed') ORDER BY created_at", [user.id])
      .map((row) => ({ ...row, payload: parseJson(row.payload_json) }));
  };
  prototype.importEmojiFavorite = function importEmojiFavorite(payload = {}) {
    const user = this.requireUser();
    const kind = payload.kind === 'unicode' ? 'unicode' : 'image';
    const value = String(payload.value || '').trim();
    const data = kind === 'image' ? Buffer.from(String(payload.dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64') : Buffer.alloc(0);
    const digest = String(payload.sha256 || '').trim().toLowerCase()
      || crypto.createHash('sha256').update(kind === 'image' ? data : value).digest('hex');
    const existing = get(this.db, 'SELECT * FROM emoji_favorites WHERE user_id=? AND kind=? AND sha256=?', [user.id, kind, digest]);
    if (existing) return normalizeFavoriteRow(this, existing);
    const contentType = String(payload.contentType || payload.content_type || '').slice(0, 100);
    const storedValue = kind === 'image' ? `data:${contentType || 'image/png'};base64,${data.toString('base64')}` : value;
    run(this.db, `INSERT INTO emoji_favorites(id,user_id,kind,value,filename,content_type,size_bytes,sha256,local_path,remote_file_id,sort_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [String(payload.id || newId('emoji_favorite')).slice(0, 200), user.id, kind, storedValue,
      String(payload.filename || '').slice(0, 180), contentType, data.length || Number(payload.size || payload.size_bytes || 0), digest, '', String(payload.id || ''),
      Number(payload.sortOrder ?? payload.sort_order ?? 0), String(payload.createdAt || payload.created_at || nowIso()), String(payload.updatedAt || payload.updated_at || nowIso())]);
    return normalizeFavoriteRow(this, get(this.db, 'SELECT * FROM emoji_favorites WHERE user_id=? AND kind=? AND sha256=?', [user.id, kind, digest]));
  };
  prototype.queueEmojiFavoriteOperation = function queueEmojiFavoriteOperation({ operationKind = '', payload = {} } = {}) {
    const user = this.requireUser();
    const cleanKind = String(operationKind || '').trim();
    const cleanPayload = payload && typeof payload === 'object' ? payload : {};
    const existing = get(this.db, 'SELECT id FROM emoji_favorite_outbox WHERE user_id=? AND operation_kind=? AND json_extract(payload_json,\'$.id\')=?', [user.id, cleanKind, String(cleanPayload.id || '')]);
    if (existing) run(this.db, 'UPDATE emoji_favorite_outbox SET payload_json=?,status=\'pending\',updated_at=? WHERE id=?', [JSON.stringify(cleanPayload), nowIso(), existing.id]);
    else run(this.db, 'INSERT INTO emoji_favorite_outbox(id,user_id,operation_kind,payload_json) VALUES(?,?,?,?)', [newId('emoji_favorite_outbox'), user.id, cleanKind, JSON.stringify(cleanPayload)]);
    return true;
  };
  prototype.markEmojiFavoriteOutbox = function markEmojiFavoriteOutbox({ id = '', status = 'completed', error = '' } = {}) {
    const user = this.requireUser();
    run(this.db, "UPDATE emoji_favorite_outbox SET status=?,attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE id=? AND user_id=?", [status === 'completed' ? 'completed' : 'failed', String(error || '').slice(0, 1000), nowIso(), id, user.id]);
    return true;
  };
  prototype.addEmojiFavorite = function addEmojiFavorite({ kind = 'image', value = '', filename = '', contentType = '', dataBase64 = '', sha256 = '', sortOrder = 0 } = {}) {
    const user = this.requireUser();
    const cleanKind = kind === 'unicode' ? 'unicode' : 'image';
    const data = cleanKind === 'image' ? Buffer.from(String(dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64') : Buffer.alloc(0);
    if (cleanKind === 'image') {
      if (!data.length || data.length > MAX_BYTES) throw new Error('单个表情不能超过 2 MB。');
      if (!TYPES.has(String(contentType || '').toLowerCase())) throw new Error('仅支持 PNG、JPG、WebP、GIF。');
    }
    const cleanValue = String(value || '').trim();
    if (cleanKind === 'unicode' && !cleanValue) throw new Error('请选择有效表情。');
    const digest = crypto.createHash('sha256').update(cleanKind === 'image' ? data : cleanValue).digest('hex');
    if (sha256 && sha256.toLowerCase() !== digest) throw new Error('表情校验失败。');
    if (get(this.db, 'SELECT id FROM emoji_favorites WHERE user_id=? AND kind=? AND sha256=?', [user.id, cleanKind, digest])) throw new Error('该表情已经收藏。');
    if (Number(get(this.db, 'SELECT COUNT(*) AS count FROM emoji_favorites WHERE user_id=?', [user.id])?.count || 0) >= MAX_COUNT) throw new Error('最多收藏 300 个表情。');
    const id = newId('emoji_favorite');
    const storedValue = cleanKind === 'image' ? `data:${contentType};base64,${data.toString('base64')}` : cleanValue;
    const now = nowIso();
    run(this.db, `INSERT INTO emoji_favorites(id,user_id,kind,value,filename,content_type,size_bytes,sha256,local_path,sort_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [id, user.id, cleanKind, storedValue, String(filename || '').slice(0, 180), String(contentType || '').slice(0, 100), data.length, digest, '', Number(sortOrder || 0), now, now]);
    const result = normalizeFavoriteRow(this, get(this.db, 'SELECT * FROM emoji_favorites WHERE id=?', [id]));
    this.queueEmojiFavoriteOperation({ operationKind: 'upsert', payload: { id, kind: result.kind, filename: result.filename, contentType: result.contentType, sha256: result.sha256, sortOrder: result.sortOrder } });
    return result;
  };
  prototype.removeEmojiFavorite = function removeEmojiFavorite({ id = '' } = {}) {
    const user = this.requireUser();
    run(this.db, 'DELETE FROM emoji_favorites WHERE id=? AND user_id=?', [String(id || ''), user.id]);
    this.queueEmojiFavoriteOperation({ operationKind: 'delete', payload: { id: String(id || '') } });
    return { ok: true };
  };
  prototype.reorderEmojiFavorites = function reorderEmojiFavorites({ ids = [] } = {}) {
    const user = this.requireUser();
    for (const [index, id] of (Array.isArray(ids) ? ids : []).entries()) run(this.db, 'UPDATE emoji_favorites SET sort_order=?,updated_at=? WHERE id=? AND user_id=?', [index, nowIso(), String(id || ''), user.id]);
    this.queueEmojiFavoriteOperation({ operationKind: 'order', payload: { ids: (Array.isArray(ids) ? ids : []).map((id) => String(id || '')).filter(Boolean) } });
    return this.listEmojiFavorites();
  };
}

function normalizeFavoriteRow(auth, row = {}) {
  return {
    id: row.id, kind: row.kind, value: row.value || '', name: row.filename || row.value || '表情', filename: row.filename || '',
    contentType: row.content_type || '', size: Number(row.size_bytes || 0), sha256: row.sha256 || '', path: row.local_path || '',
    url: row.kind === 'image' ? row.value || '' : '', sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}
