#!/usr/bin/env node

import fs from 'node:fs';

import { cloudDatabaseReadiness,createPgPool } from '../cloud/src/db.mjs';
import { evolutionModelProviderStatus } from '../cloud/src/modules/evolution/modelProvider.mjs';

const required = [
  'DATABASE_URL',
  'EVOLUTION_WORKER_DATABASE_URL',
  'DATABASE_MIGRATOR_URL',
  'JWT_SECRET',
  'EMAIL_CODE_SECRET',
  'JANUS_EVOLUTION_ACTIVE_KEY_ID',
  'JANUS_EVOLUTION_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID',
  'JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON',
  'JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID',
  'JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON',
  'JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON',
  'JANUS_S3_ENDPOINT',
  'JANUS_S3_BUCKET',
  'JANUS_S3_ACCESS_KEY_ID',
  'JANUS_S3_SECRET_ACCESS_KEY',
  'JANUS_FILE_STORAGE_ROOT',
];

const missing = required.filter((name) => !String(process.env[name] || '').trim());
const invalid = [];
const modelProvider = evolutionModelProviderStatus({ env: process.env });
if (!modelProvider.available) invalid.push(modelProvider.code || 'evolution_model_unavailable');
if (String(process.env.JWT_SECRET || '').length < 32) invalid.push('JWT_SECRET');
if (String(process.env.EMAIL_CODE_SECRET || '').length < 32) invalid.push('EMAIL_CODE_SECRET');
for (const name of ['JANUS_EVOLUTION_KEYS_JSON', 'JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON', 'JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON',
  'JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON']) {
  if (!process.env[name]) continue;
  try { JSON.parse(process.env[name]); } catch { invalid.push(name); }
}

const legacyDb = process.env.JANUS_LEGACY_CLOUD_DB || '/path/to/janus-cloud/cloud.db';
const fileStorageRoot = String(process.env.JANUS_FILE_STORAGE_ROOT || '').trim();
if (fileStorageRoot) {
  try {
    fs.mkdirSync(fileStorageRoot, { recursive: true, mode: 0o700 });
    fs.accessSync(fileStorageRoot, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    invalid.push('JANUS_FILE_STORAGE_ROOT');
  }
}

let database = null;
if (process.env.DATABASE_URL) {
  const pool = createPgPool(process.env.DATABASE_URL);
  try {
    database = await cloudDatabaseReadiness(pool);
    if (!database.ready) invalid.push('CLOUD_DATABASE_MIGRATION_REQUIRED');
  } catch (error) {
    database = { ready: false, error: error.code || error.message || String(error) };
    invalid.push('CLOUD_DATABASE_UNAVAILABLE');
  } finally {
    await pool.end();
  }
}

const result = {
  ready: missing.length === 0 && invalid.length === 0,
  missing,
  invalid: [...new Set(invalid)],
  modelProvider,
  database,
  legacyDatabasePresent: fs.existsSync(legacyDb),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ready) process.exitCode = 2;
