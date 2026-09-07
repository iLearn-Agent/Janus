import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installEmojiFavoriteMethods } from '../src/main/modules/social/application/emojiFavoriteMethods.js';
import { normalizeEmojiFavorites, EMOJI_FAVORITE_MAX_BYTES, EMOJI_FAVORITES_MAX, isSupportedEmojiFavoriteFile } from '../src/shared/emojiFavorites.js';

assert.equal(normalizeEmojiFavorites([{ kind: 'unicode', value: '😀' }, { kind: 'unicode', value: '😀' }]).length, 1);
assert.equal(EMOJI_FAVORITES_MAX, 300);
assert.equal(EMOJI_FAVORITE_MAX_BYTES, 2 * 1024 * 1024);
assert.equal(isSupportedEmojiFavoriteFile({ name: 'sticker.webp' }), true);
const longStickerDataUrl = `data:image/png;base64,${'A'.repeat(12_000)}`;
const normalizedLongSticker = normalizeEmojiFavorites([{
  kind: 'image', value: longStickerDataUrl, url: longStickerDataUrl,
  name: 'long-sticker.png', size: 9_000, sha256: 'a'.repeat(64),
}])[0];
assert.equal(normalizedLongSticker.value, longStickerDataUrl);
assert.equal(normalizedLongSticker.url, longStickerDataUrl);

class EmojiFavoriteHarness { requireUser() { return { id: 'u1' }; } }
installEmojiFavoriteMethods(EmojiFavoriteHarness.prototype);
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE emoji_favorites(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL DEFAULT '',filename TEXT NOT NULL DEFAULT '',content_type TEXT NOT NULL DEFAULT '',size_bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL DEFAULT '',local_path TEXT NOT NULL DEFAULT '',remote_file_id TEXT NOT NULL DEFAULT '',sort_order INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',UNIQUE(user_id,kind,sha256));
CREATE TABLE emoji_favorite_outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,operation_kind TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '');`);
const harness = new EmojiFavoriteHarness();
harness.db = db;
const first = harness.addEmojiFavorite({ kind: 'unicode', value: '😀' });
const second = harness.addEmojiFavorite({ kind: 'unicode', value: '🎉' });
assert.notEqual(first.sha256, second.sha256);
assert.equal(harness.listEmojiFavorites().length, 2);
assert.equal(harness.listEmojiFavoriteOutbox().length, 2);
console.log('emoji favorites smoke passed');
