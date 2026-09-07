#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!String(process.env.DATABASE_URL || '').trim()) {
  throw new Error('DATABASE_URL is required; server evolution runs only through the PostgreSQL cloud Worker.');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = path.join(root, 'cloud', 'src', 'evolution-worker.mjs');
const child = spawn(process.execPath, [worker, '--once'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`Cloud evolution Worker terminated by ${signal}.`));
    else resolve(Number(code || 0));
  });
});

if (exitCode !== 0) process.exitCode = exitCode;
