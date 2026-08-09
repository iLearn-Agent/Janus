import { readConfig } from '../src/config.mjs';
import { assertDatabaseRole,createPgPool,migrate } from '../src/db.mjs';

const config = readConfig(process.env, { requireJwt: false });
const pool = createPgPool(config.migratorDatabaseUrl);

try {
  if (config.production) await assertDatabaseRole(pool,'janus_migrator');
  await migrate(pool);
} finally {
  await pool.end();
}
