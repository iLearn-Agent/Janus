import assert from 'node:assert/strict';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createPostgresEmployeeAuthority } from '../src/modules/employees/index.mjs';

test('PostgreSQL employee authority uses the public baseline and preserves command idempotency', async (t) => {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const pg = memory.adapters.createPg();
  const pool = new pg.Pool();
  t.after(() => pool.end());

  await migrate(pool);
  await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash,email_verified) VALUES
    ('employee_user','employee-user@example.test','Employee User','employee_user','test-hash',true),
    ('bootstrap_user','bootstrap-user@example.test','Bootstrap User','bootstrap_user','test-hash',true)`);
  await pool.query('UPDATE cloud_agent_families_v3 SET default_for_new_user=false');
  await pool.query(`INSERT INTO cloud_agent_families_v3 (
    id,department_id,name,role,status,routable,current_version_id,instance_kind,recruitable,default_for_new_user,quota_cost
  ) VALUES ('employee_family','general','Employee Family','agent','active',true,'employee_family_v1','employee',true,true,1)`);

  const authority = createPostgresEmployeeAuthority({ pool, apiError });
  assert.equal(authority.capabilities().lifecycleMutation, 'command_only');
  assert.equal(authority.capabilities().instanceAliasProjection, 'overview_v1');
  assert.equal(authority.capabilities().localInstanceAdoption, 'recruit_preserve_state_v1');

  const bootstrapped = await authority.bootstrap({
    userId: 'bootstrap_user',
    deviceId: 'device_bootstrap',
    payload: { bootstrapId: 'bootstrap_v1', instances: [] },
  });
  assert.equal(bootstrapped.status, 'completed');
  assert.equal(bootstrapped.roster.length, 1);
  assert.equal(bootstrapped.systemRoster.length, 1);
  assert.equal((await authority.bootstrap({
    userId: 'bootstrap_user',
    deviceId: 'other_device',
    payload: { bootstrapId: 'bootstrap_v1', instances: [] },
  })).idempotent, true);

  await pool.query(`INSERT INTO cloud_employee_roster_states(user_id,bootstrap_status,bootstrap_id)
    VALUES('employee_user','completed','test_setup')`);
  const first = await authority.command({
    userId: 'employee_user',
    deviceId: 'device_a',
    payload: {
      action: 'recruit',
      commandId: 'command_1',
      agentFamilyId: 'employee_family',
      proposedInstanceId: 'employee_instance',
      familyInstanceSeq: 99,
      displayName: 'Employee Family Z',
    },
  });
  assert.equal(first.status, 'confirmed');
  assert.equal(first.instance.id, 'employee_instance');
  assert.equal(first.instance.familyInstanceSeq, 1);
  assert.equal(first.instance.displayName, 'Employee Family A');
  assert.equal(Number((await pool.query(`SELECT COUNT(*) AS count FROM cloud_memory_documents_v3
    WHERE user_id='employee_user' AND user_agent_instance_id='employee_instance' AND scope='general' AND slot_no=0`)).rows[0].count), 1);

  const replay = await authority.command({
    userId: 'employee_user',
    deviceId: 'device_b',
    payload: {
      action: 'recruit',
      commandId: 'command_1',
      agentFamilyId: 'employee_family',
      proposedInstanceId: 'ignored_instance',
    },
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.instance.id, 'employee_instance');

  await pool.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id,reason)
    VALUES('employee_user','legacy_employee_instance','employee_instance','test_alias')`);
  const overview = await authority.overview({ userId: 'employee_user' });
  assert.deepEqual(overview.aliases.map(({ aliasInstanceId, canonicalInstanceId, reason }) => ({
    aliasInstanceId,
    canonicalInstanceId,
    reason,
  })), [{
    aliasInstanceId: 'legacy_employee_instance',
    canonicalInstanceId: 'employee_instance',
    reason: 'test_alias',
  }]);

  const adoptedInactive = await authority.command({
    userId: 'employee_user',
    deviceId: 'device_a',
    payload: {
      action: 'recruit',
      commandId: 'command_adopt_inactive',
      agentFamilyId: 'employee_family',
      proposedInstanceId: 'local_inactive',
      adoptLocalInstance: true,
      employmentState: 'inactive',
    },
  });
  assert.equal(adoptedInactive.status, 'confirmed');
  assert.equal(adoptedInactive.instance.id, 'local_inactive');
  assert.equal(adoptedInactive.instance.employmentState, 'inactive');
  assert.equal(adoptedInactive.instance.recruitmentSource, 'local_instance_adoption');

  const conflict = await authority.command({
    userId: 'employee_user',
    deviceId: 'device_a',
    payload: {
      action: 'deactivate',
      commandId: 'command_2',
      agentInstanceId: 'employee_instance',
      expectedStateRevision: 9,
    },
  });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.code, 'employee_state_conflict');
  assert.equal((await authority.overview({ userId: 'employee_user' })).quota.used, 1);
  assert.equal((await authority.events({ userId: 'employee_user' })).length, 3);
});

function apiError(code, message, status = 400) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  return error;
}
