#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';

const envPath = process.env.JANUS_PRODUCTION_ENV_FILE || '/path/to/janus-cloud/.env';
const minioEnvPath = process.env.JANUS_MINIO_ENV_FILE || '/path/to/janus-cloud/minio.env';
const apiEnvPath = process.env.JANUS_API_ENV_FILE || '/path/to/janus-cloud/api.env';
const workerEnvPath = process.env.JANUS_WORKER_ENV_FILE || '/path/to/janus-cloud/worker.env';
const currentText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const current = parseEnv(currentText);
const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const rsa = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const apiPassword = current.JANUS_POSTGRES_API_PASSWORD || random();
const workerPassword = current.JANUS_POSTGRES_WORKER_PASSWORD || random();
const migratorPassword = current.JANUS_POSTGRES_MIGRATOR_PASSWORD || random();
const workerKey = rsa();
const taskKey = rsa();
const workerKeyId = current.JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID || 'evolution-worker-rsa-2026-01';
const taskKeyId = current.JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID || 'task-memory-key-2026-01';
const evolutionKeyId = current.JANUS_EVOLUTION_ACTIVE_KEY_ID || 'evolution-key-2026-01';
const minioAccessKey = current.JANUS_S3_ACCESS_KEY_ID || `janus${random(10)}`;
const minioSecretKey = current.JANUS_S3_SECRET_ACCESS_KEY || random(36);

const defaults = {
  NODE_ENV: 'production',
  PORT: '8788',
  JANUS_CLOUD_HOME: '/path/to/janus-cloud',
  JANUS_CLOUD_HOST: '127.0.0.1',
  JANUS_POSTGRES_API_PASSWORD: apiPassword,
  JANUS_POSTGRES_WORKER_PASSWORD: workerPassword,
  JANUS_POSTGRES_MIGRATOR_PASSWORD: migratorPassword,
  DATABASE_URL: `postgres://janus_api_login:${encodeURIComponent(apiPassword)}@127.0.0.1:5432/janus`,
  EVOLUTION_WORKER_DATABASE_URL: `postgres://janus_worker_login:${encodeURIComponent(workerPassword)}@127.0.0.1:5432/janus`,
  DATABASE_MIGRATOR_URL: `postgres://janus_migrator_login:${encodeURIComponent(migratorPassword)}@127.0.0.1:5432/janus`,
  JWT_SECRET: random(48),
  EMAIL_CODE_SECRET: random(48),
  ACCESS_TOKEN_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '30',
  MAIL_PROVIDER: process.env.MAIL_PROVIDER || 'smtp',
  MAIL_FROM: process.env.MAIL_FROM || 'Janus <no-reply@janus.local>',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: process.env.SMTP_PORT || '587',
  SMTP_SECURE: process.env.SMTP_SECURE || 'false',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  JANUS_PROVIDER_KEY_APPLICATION_EMAIL: process.env.JANUS_PROVIDER_KEY_APPLICATION_EMAIL || '',
  JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL: process.env.JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL || '',
  JANUS_PROVIDER_KEY_DISTRIBUTION_KEY: process.env.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY || '',
  JANUS_PROVIDER_KEY_DISTRIBUTION_MODEL: process.env.JANUS_PROVIDER_KEY_DISTRIBUTION_MODEL || '',
  JANUS_EVOLUTION_ACTIVE_KEY_ID: evolutionKeyId,
  JANUS_EVOLUTION_KEYS_JSON: JSON.stringify({ [evolutionKeyId]: crypto.randomBytes(32).toString('base64') }),
  JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID: workerKeyId,
  JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON: JSON.stringify({ [workerKeyId]: workerKey.publicKey }),
  JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON: JSON.stringify({ [workerKeyId]: workerKey.privateKey }),
  JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID: taskKeyId,
  JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON: JSON.stringify({ [taskKeyId]: taskKey.publicKey }),
  JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON: JSON.stringify({ [taskKeyId]: taskKey.privateKey }),
  JANUS_FILE_STORAGE_ROOT: '/path/to/janus-cloud/data/file-storage',
  JANUS_HTTP_JSON_LIMIT: '2mb',
  JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '1',
  JANUS_SYNC_V6_COMPACTION_CHANGE_THRESHOLD: '10000',
  JANUS_SYNC_V6_BATCH_RATE_LIMIT: '120',
  JANUS_SYNC_V6_RATE_LIMIT_WINDOW_MS: '60000',
  JANUS_SYNC_V6_STORAGE_QUOTA_BYTES: '5368709120',
  JANUS_S3_ENDPOINT: 'http://your-janus.example',
  JANUS_S3_REGION: 'us-east-1',
  JANUS_S3_BUCKET: 'janus-sync',
  JANUS_S3_ACCESS_KEY_ID: minioAccessKey,
  JANUS_S3_SECRET_ACCESS_KEY: minioSecretKey,
  JANUS_S3_FORCE_PATH_STYLE: 'true',
};

const next = { ...defaults, ...current };
fs.mkdirSync(new URL('.', `file://${envPath}`).pathname, { recursive: true, mode: 0o700 });
if (fs.existsSync(envPath)) {
  const backupPath = `${envPath}.backup-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}`;
  fs.copyFileSync(envPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
}
fs.writeFileSync(envPath, serializeEnv(next), { mode: 0o600 });
fs.chmodSync(envPath, 0o600);
fs.writeFileSync(minioEnvPath, `MINIO_ROOT_USER=${shellValue(next.JANUS_S3_ACCESS_KEY_ID)}\nMINIO_ROOT_PASSWORD=${shellValue(next.JANUS_S3_SECRET_ACCESS_KEY)}\n`, { mode: 0o600 });
fs.chmodSync(minioEnvPath, 0o600);
writeRestrictedEnv(apiEnvPath, next, [
  'NODE_ENV', 'PORT', 'JANUS_CLOUD_HOME', 'JANUS_CLOUD_HOST', 'DATABASE_URL', 'JWT_SECRET', 'EMAIL_CODE_SECRET',
  'ACCESS_TOKEN_TTL_SECONDS', 'REFRESH_TOKEN_TTL_DAYS', 'EMAIL_CODE_TTL_MINUTES',
  'JANUS_EMAIL_CODE_RESEND_SECONDS', 'ORGANIZATION_SECONDARY_VERIFICATION_TTL_SECONDS',
  'MAIL_PROVIDER', 'MAIL_FROM', 'SMTP_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
  'JANUS_PROVIDER_KEY_APPLICATION_EMAIL', 'JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL',
  'JANUS_PROVIDER_KEY_DISTRIBUTION_KEY', 'JANUS_PROVIDER_KEY_DISTRIBUTION_MODEL',
  'JANUS_EVOLUTION_ACTIVE_KEY_ID', 'JANUS_EVOLUTION_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID', 'JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON',
  'JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID', 'JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON',
  'JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON', 'JANUS_FILE_STORAGE_ROOT', 'JANUS_HTTP_JSON_LIMIT',
  'JANUS_SYNC_REQUIRE_CLIENT_CONTRACT', 'JANUS_SYNC_V6_COMPACTION_CHANGE_THRESHOLD',
  'JANUS_SYNC_V6_BATCH_RATE_LIMIT', 'JANUS_SYNC_V6_RATE_LIMIT_WINDOW_MS', 'JANUS_SYNC_V6_STORAGE_QUOTA_BYTES',
  'JANUS_S3_ENDPOINT', 'JANUS_S3_REGION', 'JANUS_S3_BUCKET', 'JANUS_S3_ACCESS_KEY_ID',
  'JANUS_S3_SECRET_ACCESS_KEY', 'JANUS_S3_FORCE_PATH_STYLE', 'JANUS_S3_SESSION_TOKEN',
]);
writeRestrictedEnv(workerEnvPath, next, [
  'NODE_ENV', 'EVOLUTION_WORKER_DATABASE_URL', 'JWT_SECRET',
  'JANUS_EVOLUTION_ACTIVE_KEY_ID', 'JANUS_EVOLUTION_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID', 'JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON', 'JANUS_TASK_MEMORY_CLOUD_ACTIVE_KEY_ID',
  'JANUS_TASK_MEMORY_CLOUD_PUBLIC_KEYS_JSON', 'JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON',
  'JANUS_EVOLUTION_WORKER_INTERVAL_MS', 'JANUS_EVOLUTION_WORKER_BATCH_SIZE',
  'JANUS_EVOLUTION_BACKFILL_BATCH_SIZE', 'JANUS_CLUSTER_WORKER_BATCH_SIZE',
  'JANUS_PHASE8_CLUSTER_EVALUATION_INTERVAL_MS', 'JANUS_PHASE8_CLUSTER_RETRY_INTERVAL_MS',
  'JANUS_PHASE8_CANARY_MIN_USERS', 'JANUS_PHASE8_CANARY_MIN_CASES',
  'JANUS_MARKET_CANARY_MIN_DURATION_MS', 'JANUS_MARKET_CANARY_MAX_DURATION_MS',
]);
process.stdout.write(`${JSON.stringify({ configured: true, envPath, minioEnvPath, apiEnvPath, workerEnvPath, preservedModelConfiguration: Boolean(current.JANUS_EVOLUTION_PROVIDER_BASE_URL && current.JANUS_EVOLUTION_PROVIDER_API_KEY && current.JANUS_EVOLUTION_MODEL) })}\n`);

function parseEnv(text) {
  const result = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = unquote(match[2]);
  }
  return result;
}

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function serializeEnv(values) {
  return `${Object.entries(values).map(([name, value]) => `${name}=${shellValue(value)}`).join('\n')}\n`;
}

function shellValue(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function writeRestrictedEnv(filename, values, names) {
  const selected = Object.fromEntries(names.filter((name) => Object.hasOwn(values, name)).map((name) => [name, values[name]]));
  fs.writeFileSync(filename, serializeEnv(selected), { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}
