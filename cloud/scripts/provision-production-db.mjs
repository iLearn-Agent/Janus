#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const required = ['JANUS_POSTGRES_API_PASSWORD', 'JANUS_POSTGRES_WORKER_PASSWORD', 'JANUS_POSTGRES_MIGRATOR_PASSWORD'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);

const sql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_api') THEN CREATE ROLE janus_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_evolution_worker') THEN CREATE ROLE janus_evolution_worker NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_migrator') THEN CREATE ROLE janus_migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_api_login') THEN CREATE ROLE janus_api_login LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_worker_login') THEN CREATE ROLE janus_worker_login LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='janus_migrator_login') THEN CREATE ROLE janus_migrator_login LOGIN CREATEROLE; END IF;
END $$;
ALTER ROLE janus_api_login PASSWORD ${literal(process.env.JANUS_POSTGRES_API_PASSWORD)};
ALTER ROLE janus_worker_login PASSWORD ${literal(process.env.JANUS_POSTGRES_WORKER_PASSWORD)};
ALTER ROLE janus_migrator_login PASSWORD ${literal(process.env.JANUS_POSTGRES_MIGRATOR_PASSWORD)};
GRANT janus_api TO janus_api_login;
GRANT janus_evolution_worker TO janus_worker_login;
GRANT janus_migrator TO janus_migrator_login;
`;
run('psql', ['-v', 'ON_ERROR_STOP=1'], { input: sql });
const exists = run('psql', ['-tAc', "SELECT 1 FROM pg_database WHERE datname='janus'"], { capture: true }).trim() === '1';
if (!exists) run('createdb', ['--owner', 'janus_migrator_login', 'janus']);
run('psql', ['-d', 'janus', '-v', 'ON_ERROR_STOP=1', '-c', 'GRANT CONNECT ON DATABASE janus TO janus_api_login,janus_worker_login;']);
process.stdout.write(`${JSON.stringify({ provisioned: true, database: 'janus' })}\n`);

function run(command, args, { input = '', capture = false } = {}) {
  const result = spawnSync('sudo', ['-n', '-u', 'postgres', command, ...args], {
    input,
    encoding: 'utf8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe'],
  });
  if (result.status !== 0) throw new Error(String(result.stderr || `${command} failed`).trim());
  return String(result.stdout || '');
}

function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }
