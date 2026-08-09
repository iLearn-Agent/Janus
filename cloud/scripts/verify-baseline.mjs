#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { applyMigrationFiles, assertCloudDatabaseReady, createPgPool } from '../src/db.mjs';
import { cloudSchemaFingerprint } from '../src/schemaFingerprint.mjs';

const projectRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const databaseDirectory = path.join(projectRoot, 'cloud', 'database');
const metadata = JSON.parse(fs.readFileSync(path.join(databaseDirectory, 'baseline-sync8.meta.json'), 'utf8'));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-baseline-verify-'));
const dataDirectory = path.join(temporaryRoot, 'postgres');
const socketDirectory = path.join(temporaryRoot, 'socket');
const port = 56000 + Math.floor(Math.random() * 500);
const bindir = command('pg_config', ['--bindir']).trim();
const bootstrapUser = 'janus_validation_bootstrap';
const databaseUrl = `postgres://janus_migrator_login@127.0.0.1:${port}/janus_verify`;
let started = false;

try {
  fs.mkdirSync(socketDirectory, { recursive: true });
  command(path.join(bindir, 'initdb'), ['--username', bootstrapUser, '--auth=trust', '--no-locale', '--encoding=UTF8', '--pgdata', dataDirectory]);
  command(path.join(bindir, 'pg_ctl'), ['--pgdata', dataDirectory, '--options', `-p ${port} -k ${socketDirectory} -h 127.0.0.1`, '--wait', 'start'], { quiet: true });
  started = true;
  command(path.join(bindir, 'createdb'), ['--host', '127.0.0.1', '--port', String(port), '--username', bootstrapUser, '--maintenance-db', 'postgres', 'janus_verify']);
  command(path.join(bindir, 'psql'), [
    '--host', '127.0.0.1', '--port', String(port), '--username', bootstrapUser, '--dbname', 'janus_verify',
    '--set', 'ON_ERROR_STOP=1', '--file', path.join(databaseDirectory, 'roles.sql'),
  ]);
  command(path.join(bindir, 'psql'), [
    '--host', '127.0.0.1', '--port', String(port), '--username', bootstrapUser, '--dbname', 'janus_verify',
    '--set', 'ON_ERROR_STOP=1', '--command', [
      'CREATE ROLE janus_migrator_login LOGIN;',
      'GRANT janus_migrator TO janus_migrator_login;',
      'GRANT CONNECT ON DATABASE janus_verify TO janus_migrator_login;',
      'GRANT USAGE, CREATE ON SCHEMA public TO janus_migrator_login;',
    ].join(' '),
  ]);

  const pool = createPgPool(databaseUrl);
  try {
    await pool.query('BEGIN');
    try {
      await pool.query(fs.readFileSync(path.join(databaseDirectory, 'baseline-sync8.sql'), 'utf8'));
      await pool.query(fs.readFileSync(path.join(databaseDirectory, 'seed-agent-catalog.sql'), 'utf8'));
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    const fingerprint = await cloudSchemaFingerprint(pool);
    if (fingerprint.fingerprint !== metadata.schemaFingerprint || fingerprint.objectCount !== metadata.schemaObjectCount) {
      throw new Error(`Baseline fingerprint mismatch: ${fingerprint.fingerprint}/${fingerprint.objectCount}`);
    }
    await applyMigrationFiles(pool, path.join(databaseDirectory, 'migrations'));
    const readiness = await assertCloudDatabaseReady(pool);
    const userCount = Number((await pool.query('SELECT count(*) AS count FROM public.users')).rows[0].count);
    const catalogCount = Number((await pool.query('SELECT count(*) AS count FROM public.cloud_agent_families_v3')).rows[0].count);
    if (userCount !== 0) throw new Error('Baseline contains user rows.');
    if (catalogCount < 1) throw new Error('Generic Agent catalog seed is empty.');
    await pool.query('BEGIN');
    try {
      await pool.query(fs.readFileSync(path.join(databaseDirectory, 'baseline-sync8.sql'), 'utf8'));
      throw new Error('Baseline unexpectedly accepted a non-empty database.');
    } catch (error) {
      await pool.query('ROLLBACK');
      if (!/requires an empty public schema/i.test(String(error.message || error))) throw error;
    }
    process.stdout.write(`${JSON.stringify({ verified: true, fingerprint, readiness, userCount, catalogCount }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
} finally {
  if (started) spawnSync(path.join(bindir, 'pg_ctl'), ['--pgdata', dataDirectory, '--mode', 'fast', '--wait', 'stop'], { stdio: 'ignore' });
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function command(executable, args, { quiet = false } = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', stdio: quiet ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(String(result.stderr || `${executable} failed`).trim());
  return String(result.stdout || '');
}
