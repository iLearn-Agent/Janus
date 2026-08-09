#!/usr/bin/env node

import fs from 'node:fs';

import { readConfig } from '../src/config.mjs';
import { assertDatabaseRole, createPgPool } from '../src/db.mjs';
import { markBaselineEquivalent } from '../src/baseline.mjs';

const metadata = JSON.parse(fs.readFileSync(new URL('../database/baseline-sync8.meta.json', import.meta.url), 'utf8'));
const config = readConfig(process.env, { requireJwt: false });
const pool = createPgPool(config.migratorDatabaseUrl);

try {
  if (config.production) await assertDatabaseRole(pool, 'janus_migrator');
  const result = await markBaselineEquivalent(pool, metadata);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
