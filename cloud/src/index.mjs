import { readConfig } from './config.mjs';
import { assertCloudDatabaseReady,assertDatabaseRole,createPgPool,migrate } from './db.mjs';
import { createMailer } from './mailer.mjs';
import { createApp } from './server.mjs';

const config = readConfig();
const pool = createPgPool(config.databaseUrl);

if (config.production) {
  await assertDatabaseRole(pool,'janus_api');
  await assertCloudDatabaseReady(pool);
} else await migrate(pool);

const app = createApp({
  pool,
  config,
  mailer: createMailer(config),
});

const server = app.listen(config.port, config.host, () => {
  console.info(`[janus-cloud] API listening on ${config.host}:${config.port}`);
});

function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
