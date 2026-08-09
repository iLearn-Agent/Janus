#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const directory = path.resolve(argumentValue('--output', 'deploy/secrets'));
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

for (const name of [
  'postgres_bootstrap_password', 'postgres_api_password', 'postgres_worker_password', 'postgres_migrator_password',
  'minio_root_password', 'api_jwt_secret', 'api_email_code_secret', 'api_smtp_password',
  'api_s3_secret', 'worker_s3_secret', 'worker_provider_api_key',
]) write(name, crypto.randomBytes(48).toString('base64url'));

const evolutionEnvelope = crypto.randomBytes(32).toString('base64');
write('evolution_keys', JSON.stringify({ 'evolution-key-1': evolutionEnvelope }), '.json');
const evolutionWorker = keyPair();
write('evolution_worker_public_keys', JSON.stringify({ 'evolution-worker-1': evolutionWorker.publicKey }), '.json');
write('evolution_worker_private_keys', JSON.stringify({ 'evolution-worker-1': evolutionWorker.privateKey }), '.json');
const taskMemory = keyPair();
write('task_memory_public_keys', JSON.stringify({ 'task-memory-1': taskMemory.publicKey }), '.json');
write('task_memory_private_keys', JSON.stringify({ 'task-memory-1': taskMemory.privateKey }), '.json');

const update = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
write('desktop_update_public_key', update.publicKey, '.pem');
write('desktop_update_private_key', update.privateKey, '.pem');
process.stdout.write(`Generated deployment secrets in ${directory}. Keep this directory private.\n`);

function keyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function write(name, value, extension = '.txt') {
  const filename = path.join(directory, `${name}${extension}`);
  if (fs.existsSync(filename)) throw new Error(`Refusing to replace existing secret: ${filename}`);
  fs.writeFileSync(filename, `${String(value).replace(/[\r\n]+$/g, '')}\n`, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] || fallback;
}
