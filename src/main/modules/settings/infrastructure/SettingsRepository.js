import { get, run } from '../../../db.js';
import { nowIso } from '../../../utils.js';

export class SettingsRepository {
  constructor(db) {
    this.db = db;
  }

  get(key, fallback = '') {
    const row = get(this.db, 'SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  }

  set(key, value) {
    run(
      this.db,
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), nowIso()],
    );
  }
}
