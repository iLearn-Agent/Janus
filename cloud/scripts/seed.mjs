import { readConfig } from '../src/config.mjs';
import { createPgPool, migrate } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';
import { passwordValidationMessage } from '../../src/shared/passwordPolicy.js';

const config = readConfig(process.env, { requireJwt: false });
const pool = createPgPool(config.databaseUrl);
const adminEmail = String(process.env.SEED_ADMIN_EMAIL || 'admin@janus.local').trim().toLowerCase();
const adminPassword = String(process.env.SEED_ADMIN_PASSWORD || '');

const adminPasswordError = passwordValidationMessage(adminPassword);
if (adminPasswordError) throw new Error(`SEED_ADMIN_PASSWORD invalid: ${adminPasswordError}`);

try {
  await migrate(pool);
  await pool.query(
    `INSERT INTO users (id, email, display_name, username, avatar_url, email_verified, role, password_hash, created_at, updated_at)
     VALUES ('user_admin', $1, 'Admin', 'admin', '', true, 'admin', $2, now(), now())
     ON CONFLICT (email) DO NOTHING`,
    [adminEmail, hashPassword(adminPassword)],
  );
  console.info(`[janus-cloud] seeded admin ${adminEmail}`);
} finally {
  await pool.end();
}
