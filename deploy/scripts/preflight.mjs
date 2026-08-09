#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readEnvFile, validateServiceConfig } from './check-config.mjs';
import { DATABASE_SYNC_PROTOCOL_VERSION } from '../../src/shared/databaseEvolutionContract.js';

const root = path.resolve(process.cwd());
const envDirectory = path.resolve(argumentValue('--env-dir', path.join(root, 'deploy/env')));
const secretDirectory = path.resolve(argumentValue('--secret-dir', path.join(root, 'deploy/secrets')));
const errors = [];
const values = {};
for (const service of ['compose', 'desktop', 'api', 'worker', 'migrator', 'storage', 'release']) {
  const filename = path.join(envDirectory, `${service}.env`);
  try {
    values[service] = readEnvFile(filename);
    errors.push(...validateServiceConfig(service, values[service], { filename, secretDirectory }).errors);
  } catch (error) {
    errors.push(error.message || String(error));
  }
}

const databaseUrls = [values.api?.DATABASE_URL, values.worker?.EVOLUTION_WORKER_DATABASE_URL, values.migrator?.DATABASE_MIGRATOR_URL].filter(Boolean);
if (new Set(databaseUrls).size !== databaseUrls.length) errors.push('API, Worker and Migrator must use distinct PostgreSQL login URLs.');
for (const [composeName, service, serviceName] of [
  ['MINIO_ROOT_USER', 'storage', 'MINIO_ROOT_USER'],
  ['JANUS_S3_BUCKET', 'storage', 'JANUS_S3_BUCKET'],
  ['JANUS_MINIO_API_ACCESS_KEY', 'storage', 'JANUS_MINIO_API_ACCESS_KEY'],
  ['JANUS_MINIO_WORKER_ACCESS_KEY', 'storage', 'JANUS_MINIO_WORKER_ACCESS_KEY'],
  ['JANUS_S3_BUCKET', 'api', 'JANUS_S3_BUCKET'],
  ['JANUS_MINIO_API_ACCESS_KEY', 'api', 'JANUS_S3_ACCESS_KEY_ID'],
  ['JANUS_S3_BUCKET', 'worker', 'JANUS_S3_BUCKET'],
  ['JANUS_MINIO_WORKER_ACCESS_KEY', 'worker', 'JANUS_S3_ACCESS_KEY_ID'],
]) {
  const composeValue = String(values.compose?.[composeName] || '').trim();
  const serviceValue = String(values[service]?.[serviceName] || '').trim();
  if (composeValue && serviceValue && composeValue !== serviceValue) {
    errors.push(`compose.env ${composeName} must match ${service}.env ${serviceName}.`);
  }
}
const publicS3Endpoint = String(values.api?.JANUS_S3_PUBLIC_ENDPOINT || '').trim();
const publicS3Domain = String(values.compose?.JANUS_S3_DOMAIN || '').trim();
if (publicS3Endpoint && publicS3Domain) {
  try {
    const parsedPublicS3Endpoint = new URL(publicS3Endpoint);
    if (parsedPublicS3Endpoint.hostname !== publicS3Domain) {
      errors.push('api.env JANUS_S3_PUBLIC_ENDPOINT hostname must match compose.env JANUS_S3_DOMAIN.');
    }
    if (parsedPublicS3Endpoint.pathname !== '/' || parsedPublicS3Endpoint.search || parsedPublicS3Endpoint.hash) {
      errors.push('api.env JANUS_S3_PUBLIC_ENDPOINT must be an HTTPS origin without a path, query or fragment.');
    }
  } catch {
    errors.push('api.env JANUS_S3_PUBLIC_ENDPOINT must be a valid HTTPS URL.');
  }
}
if (Number(DATABASE_SYNC_PROTOCOL_VERSION) !== 9) errors.push(`Expected Cloud Sync Protocol 9, found ${DATABASE_SYNC_PROTOCOL_VERSION}.`);

if (!process.argv.includes('--skip-compose')) {
  const composeEnv = path.join(envDirectory, 'compose.env');
  const result = spawnSync('docker', ['compose', '--env-file', composeEnv, '-f', 'deploy/community/compose.yml', 'config', '--quiet'], { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') errors.push('docker compose is required unless --skip-compose is used.');
  else if (result.status !== 0) errors.push(String(result.stderr || result.stdout || 'docker compose config failed').trim());
}

if (errors.length) {
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Deployment preflight passed for Sync Protocol ${DATABASE_SYNC_PROTOCOL_VERSION}.\n`);

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] || fallback;
}
