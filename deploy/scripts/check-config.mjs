#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const SERVICE_NAMES = new Set(['compose', 'desktop', 'api', 'worker', 'migrator', 'storage', 'release']);
const PLACEHOLDER = /(?:replace[-_ ]?me|example\.(?:com|invalid)|changeme|your[-_ ]|<(?![^>\r\n]*@)[^>]+>)/i;
const COMPOSE_NAMES = new Set([
  'JANUS_DOMAIN',
  'JANUS_S3_DOMAIN',
  'MINIO_ROOT_USER',
  'JANUS_S3_BUCKET',
  'JANUS_MINIO_API_ACCESS_KEY',
  'JANUS_MINIO_WORKER_ACCESS_KEY',
]);
const FORBIDDEN = {
  compose: [/PASSWORD/i, /SECRET/i, /TOKEN/i, /PRIVATE/i, /DATABASE/i, /^SMTP/i, /PROVIDER_API_KEY/i],
  desktop: [/SMTP/i, /DATABASE/i, /PRIVATE.*KEY/i, /_SECRET/i, /_PASSWORD/i, /_TOKEN/i],
  api: [/EVOLUTION_PROVIDER_API_KEY/i, /WORKER_PRIVATE/i, /TASK_MEMORY.*PRIVATE/i, /RELEASE_SIGNING_PRIVATE/i, /CSC_/i, /APPLE_APP_SPECIFIC/i],
  worker: [/JWT_SECRET/i, /EMAIL_CODE_SECRET/i, /^SMTP/i, /RELEASE_SIGNING_PRIVATE/i, /CSC_/i, /APPLE_APP_SPECIFIC/i],
  migrator: [/JWT/i, /^SMTP/i, /S3_/i, /EVOLUTION/i, /RELEASE/i],
  storage: [/DATABASE/i, /JWT/i, /^SMTP/i, /EVOLUTION/i, /RELEASE/i],
  release: [/DATABASE/i, /JWT/i, /EMAIL_CODE/i, /^SMTP/i, /EVOLUTION_WORKER/i, /TASK_MEMORY/i],
};

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const service = String(process.argv[2] || '').trim().toLowerCase();
  if (!SERVICE_NAMES.has(service)) throw new Error(`Expected one of: ${[...SERVICE_NAMES].join(', ')}`);
  const filename = path.resolve(argumentValue('--env', `deploy/env/${service}.env`));
  const secretDirectory = path.resolve(argumentValue('--secret-dir', path.join(path.dirname(filename), '..', 'secrets')));
  const result = validateServiceConfig(service, readEnvFile(filename), { filename, secretDirectory });
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${service} configuration is valid: ${filename}\n`);
}

export function readEnvFile(filename) {
  if (!fs.existsSync(filename)) throw new Error(`Configuration file does not exist: ${filename}`);
  const env = {};
  for (const raw of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error(`Invalid environment line in ${filename}: ${raw}`);
    env[match[1]] = unquote(match[2]);
  }
  return env;
}

export function validateServiceConfig(service, env, { filename = service, secretDirectory = '' } = {}) {
  const errors = [];
  for (const [name, value] of Object.entries(env)) {
    if (FORBIDDEN[service].some((pattern) => pattern.test(name))) errors.push(`${filename}: ${name} is outside the ${service} secret boundary.`);
    if (service === 'compose' && !COMPOSE_NAMES.has(name)) errors.push(`${filename}: ${name} is not an allowed Compose-wide setting.`);
    if (value && PLACEHOLDER.test(value)) errors.push(`${filename}: ${name} still contains an example placeholder.`);
    if (name.endsWith('_FILE') && value) validateSecretFile(name, value, errors, filename, secretDirectory);
  }
  const required = requiredNames(service);
  for (const group of required) {
    if (!group.some((name) => String(env[name] || '').trim())) errors.push(`${filename}: set ${group.join(' or ')}.`);
  }
  if (service === 'desktop') {
    const mode = String(env.JANUS_DISTRIBUTION_MODE || 'community').trim().toLowerCase();
    if (!['community', 'official'].includes(mode)) errors.push(`${filename}: JANUS_DISTRIBUTION_MODE must be community or official.`);
  }
  if (service === 'compose') {
    for (const name of ['JANUS_DOMAIN', 'JANUS_S3_DOMAIN']) {
      const domain = String(env[name] || '').trim();
      if (domain && (domain.includes('://') || domain.includes('/') || /\s/.test(domain))) {
        errors.push(`${filename}: ${name} must be a DNS name without a scheme, path or whitespace.`);
      }
    }
    if (String(env.JANUS_DOMAIN || '').trim() === String(env.JANUS_S3_DOMAIN || '').trim()) {
      errors.push(`${filename}: JANUS_DOMAIN and JANUS_S3_DOMAIN must be different DNS names.`);
    }
  }
  for (const name of ['JANUS_PUBLIC_BASE_URL', 'JANUS_S3_PUBLIC_ENDPOINT', 'JANUS_DESKTOP_UPDATE_URL', 'JANUS_PACKAGED_AUTH_URL', 'JANUS_PACKAGED_CLOUD_URL']) {
    const value = String(env[name] || '').trim();
    if (value && !value.startsWith('https://')) errors.push(`${filename}: ${name} must use HTTPS outside local development.`);
  }
  return { ok: errors.length === 0, errors };
}

function requiredNames(service) {
  if (service === 'compose') return [
    ['JANUS_DOMAIN'], ['JANUS_S3_DOMAIN'], ['MINIO_ROOT_USER'], ['JANUS_S3_BUCKET'],
    ['JANUS_MINIO_API_ACCESS_KEY'], ['JANUS_MINIO_WORKER_ACCESS_KEY'],
  ];
  if (service === 'api') return [
    ['DATABASE_URL'], ['JWT_SECRET', 'JWT_SECRET_FILE'], ['EMAIL_CODE_SECRET', 'EMAIL_CODE_SECRET_FILE'],
    ['JANUS_PUBLIC_BASE_URL'], ['SMTP_URL', 'SMTP_HOST'], ['SMTP_PASS', 'SMTP_PASS_FILE'],
    ['JANUS_S3_ENDPOINT'], ['JANUS_S3_PUBLIC_ENDPOINT'], ['JANUS_S3_BUCKET'], ['JANUS_S3_ACCESS_KEY_ID'], ['JANUS_S3_SECRET_ACCESS_KEY', 'JANUS_S3_SECRET_ACCESS_KEY_FILE'],
  ];
  if (service === 'worker') return [
    ['EVOLUTION_WORKER_DATABASE_URL'], ['JANUS_EVOLUTION_PROVIDER_BASE_URL', 'JANUS_EVOLUTION_CODEX_HOME'],
    ['JANUS_EVOLUTION_PROVIDER_API_KEY', 'JANUS_EVOLUTION_PROVIDER_API_KEY_FILE', 'JANUS_EVOLUTION_CODEX_HOME'],
    ['JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON', 'JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON_FILE'],
    ['JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON', 'JANUS_TASK_MEMORY_CLOUD_PRIVATE_KEYS_JSON_FILE'],
  ];
  if (service === 'migrator') return [['DATABASE_MIGRATOR_URL']];
  if (service === 'storage') return [['MINIO_ROOT_USER'], ['MINIO_ROOT_PASSWORD', 'MINIO_ROOT_PASSWORD_FILE']];
  if (service === 'release') return [
    ['JANUS_DESKTOP_APP_ID'], ['JANUS_DESKTOP_PRODUCT_NAME'],
    ['JANUS_DESKTOP_SIGNING_PUBLIC_KEY_FILE'], ['JANUS_RELEASE_SIGNING_PRIVATE_KEY_FILE'],
  ];
  return [];
}

function validateSecretFile(name, filename, errors, source, secretDirectory = '') {
  const resolved = resolveSecretFile(filename, secretDirectory, errors, source, name);
  if (!resolved) return;
  if (!fs.existsSync(resolved)) return errors.push(`${source}: ${name} does not exist: ${resolved}`);
  const mode = fs.statSync(resolved).mode & 0o777;
  if ((mode & 0o077) !== 0) errors.push(`${source}: ${name} must not be readable or writable by group/others (${mode.toString(8)}).`);
}

function resolveSecretFile(filename, secretDirectory, errors, source, name) {
  const value = String(filename || '').trim();
  const containerPrefix = '/run/secrets/';
  if (!value.startsWith(containerPrefix)) return path.resolve(value);
  const secretName = value.slice(containerPrefix.length);
  if (!secretDirectory) {
    errors.push(`${source}: ${name} uses a container secret path but no host secret directory was provided.`);
    return '';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(secretName)) {
    errors.push(`${source}: ${name} has an invalid container secret name.`);
    return '';
  }
  const candidates = ['', '.txt', '.json', '.pem']
    .map((extension) => path.join(secretDirectory, `${secretName}${extension}`))
    .filter((candidate) => fs.existsSync(candidate));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    errors.push(`${source}: ${name} matches multiple host secret files for ${value}.`);
    return '';
  }
  return path.join(secretDirectory, secretName);
}

function unquote(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) return text.slice(1, -1);
  return text;
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] || fallback;
}
