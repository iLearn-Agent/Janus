#!/usr/bin/env node

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const separator = process.argv.indexOf('--');
const command = separator >= 0 ? process.argv[separator + 1] : '';
const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
if (!command) throw new Error('Usage: node deploy/scripts/with-secrets.mjs -- <command> [args...]');

const env = { ...process.env };
const copiedSecretDirectory = String(process.env.JANUS_SECRET_DIRECTORY || '').trim();
delete env.JANUS_SECRET_DIRECTORY;
for (const [fileName, filePathValue] of Object.entries(process.env)) {
  if (!fileName.endsWith('_FILE') || !filePathValue) continue;
  const targetName = fileName.slice(0, -5);
  if (!/^[A-Z][A-Z0-9_]*$/.test(targetName)) continue;
  if (Object.hasOwn(process.env, targetName) && String(process.env[targetName] || '').trim()) {
    throw new Error(`Set only one of ${targetName} or ${fileName}.`);
  }
  const configuredFilePath = String(filePathValue).trim();
  const filePath = copiedSecretDirectory && configuredFilePath.startsWith('/run/secrets/')
    ? path.join(copiedSecretDirectory, path.basename(configuredFilePath))
    : configuredFilePath;
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${fileName} must point to a regular file.`);
  env[targetName] = fs.readFileSync(filePath, 'utf8').replace(/[\r\n]+$/g, '');
  delete env[fileName];
}

const result = spawnSync(command, args, { env, stdio: 'inherit', shell: false, windowsHide: true });
if (result.error) throw result.error;
process.exitCode = Number(result.status || 0);
