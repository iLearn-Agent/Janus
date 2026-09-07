import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { createPostgresEmployeeAuthority } from '../cloud/src/modules/employees/index.mjs';
import { createSyncV6Service } from '../cloud/src/modules/sync/syncV6.mjs';

const databaseUrl = String(process.env.JANUS_REHEARSAL_DATABASE_URL || '');
const allowed = String(process.env.JANUS_ALLOW_DATABASE_REHEARSAL || '').toLowerCase() === 'true';
if (!databaseUrl || !allowed) {
  console.log('Employee PostgreSQL rehearsal skipped: set JANUS_REHEARSAL_DATABASE_URL and JANUS_ALLOW_DATABASE_REHEARSAL=true.');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'cloud', 'migrations');
const schema = `janus_employee_rehearsal_${crypto.randomBytes(6).toString('hex')}`;
const common = {
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 10_000,
};
const admin = new pg.Pool({ ...common, max: 1 });
const pool = new pg.Pool({ ...common, max: 4, options: `-c search_path=${schema}` });

try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
    await pool.query('INSERT INTO schema_migrations(filename) VALUES($1)', [file]);
  }
  await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash,email_verified)
    VALUES('employee_rehearsal_user','employee.rehearsal@janus.test','Employee Rehearsal','employee_rehearsal','rehearsal-hash',true)`);
  await pool.query(`INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id,policy_version)
    VALUES('employee_rehearsal_user','completed','rehearsal_setup','employee_cloud_authority_v1')`);
  for (let index = 1; index <= 11; index += 1) {
    await pool.query(`INSERT INTO cloud_agent_families_v3(
      id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,quota_cost
    ) VALUES($1,'general',$2,'agent','active',true,$3,'employee',true,1)`, [
      `employee_family_${index}`, `Employee ${index}`, `employee_version_${index}`,
    ]);
  }
  for (let index = 1; index <= 9; index += 1) {
    await pool.query(`INSERT INTO cloud_user_agent_instances_v3(
      user_id,id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,quota_exempt,
      state_revision,recruitment_source,policy_version
    ) VALUES('employee_rehearsal_user',$1,$2,$3,'active','employee','active',false,1,'migration','employee_cloud_authority_v1')`, [
      `employee_instance_${index}`, `employee_family_${index}`, `employee_version_${index}`,
    ]);
  }
  const authority = createPostgresEmployeeAuthority({ pool, apiError });
  const [first, second] = await Promise.all([
    authority.command({ userId: 'employee_rehearsal_user', deviceId: 'device_a', payload: {
      action: 'recruit', commandId: 'concurrent_a', agentFamilyId: 'employee_family_10', proposedInstanceId: 'employee_instance_10',
    } }),
    authority.command({ userId: 'employee_rehearsal_user', deviceId: 'device_b', payload: {
      action: 'recruit', commandId: 'concurrent_b', agentFamilyId: 'employee_family_11', proposedInstanceId: 'employee_instance_11',
    } }),
  ]);
  const confirmed = [first, second].filter((item) => item.status === 'confirmed');
  const rejected = [first, second].filter((item) => item.code === 'employee_quota_exceeded');
  if (confirmed.length !== 1 || rejected.length !== 1) throw new Error(`Expected one confirmed and one quota rejection: ${JSON.stringify([first, second])}`);
  const active = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM cloud_user_agent_instances_v3
    WHERE user_id='employee_rehearsal_user' AND instance_kind='employee' AND employment_state='active' AND quota_exempt=false`)).rows[0].count);
  if (active !== 10) throw new Error(`Expected 10 active employees, received ${active}.`);
  const replay = await authority.command({ userId: 'employee_rehearsal_user', deviceId: 'device_replay', payload: {
    action: 'recruit', commandId: confirmed[0].commandId,
    agentFamilyId: confirmed[0].instance.agentFamilyId, proposedInstanceId: 'ignored_replay_id',
  } });
  if (!replay.idempotent || replay.instance.id !== confirmed[0].instance.id) throw new Error('Confirmed employee command was not idempotent.');

  const sync = createSyncV6Service({ pool, apiError, env: { JANUS_SYNC_REQUIRE_CLIENT_CONTRACT: '0' } });
  await sync.submitBatch({ userId: 'employee_rehearsal_user', deviceId: 'device_a', scopes: ['sync:*'] }, {
    batchId: 'employee_lifecycle_spoof', changes: [{
      changeId: 'employee_lifecycle_spoof_change', entityType: 'user_agent_instance', entityId: confirmed[0].instance.id,
      operation: 'upsert', baseRevision: 0, occurredAt: new Date().toISOString(), payload: {
        id: confirmed[0].instance.id, agent_family_id: confirmed[0].instance.agentFamilyId,
        status: 'inactive', employment_state: 'inactive', instance_kind: 'governance', state_revision: 99,
      },
    }],
  });
  const protectedRow = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [
    'employee_rehearsal_user', confirmed[0].instance.id,
  ])).rows[0];
  if (protectedRow.status !== 'active' || protectedRow.employment_state !== 'active' || protectedRow.instance_kind !== 'employee' || Number(protectedRow.state_revision) !== 1) {
    throw new Error('Sync V6 overwrote cloud-authoritative employee lifecycle fields.');
  }
  console.log('Employee PostgreSQL rehearsal passed: concurrent quota, idempotency, and lifecycle sync protection verified.');
} finally {
  await pool.end().catch(() => null);
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => null);
  await admin.end().catch(() => null);
}

function apiError(code, message, status = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  return error;
}
