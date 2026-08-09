import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newDb } from 'pg-mem';

import { resolveOwnedEmployeeInstanceId } from '../src/modules/employees/index.mjs';
import { requireOwnedInstance } from '../src/modules/evolution/index.mjs';

test('Evolution ownership resolves only aliases whose canonical instance belongs to the same user', async (t) => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  t.after(() => pool.end());
  await pool.query(`CREATE TABLE cloud_user_agent_instances_v3 (
    user_id text NOT NULL,
    id text NOT NULL,
    PRIMARY KEY(user_id,id)
  )`);
  await pool.query(`CREATE TABLE cloud_user_agent_instance_aliases_v3 (
    user_id text NOT NULL,
    alias_instance_id text NOT NULL,
    canonical_instance_id text NOT NULL,
    PRIMARY KEY(user_id,alias_instance_id)
  )`);
  await pool.query(`INSERT INTO cloud_user_agent_instances_v3(user_id,id) VALUES
    ('user_a','canonical_a'),
    ('user_a','legacy_row_a'),
    ('user_b','canonical_b')`);
  await pool.query(`INSERT INTO cloud_user_agent_instance_aliases_v3(user_id,alias_instance_id,canonical_instance_id) VALUES
    ('user_a','legacy_a','canonical_a'),
    ('user_a','legacy_head_a','legacy_row_a'),
    ('user_a','legacy_row_a','legacy_a'),
    ('user_a','broken_cross_user','canonical_b'),
    ('user_a','cycle_a','cycle_b'),
    ('user_a','cycle_b','cycle_a'),
    ('user_b','legacy_b','canonical_b')`);

  const apiError = (code, message, status) => Object.assign(new Error(message), { code, status });
  assert.equal(await requireOwnedInstance(pool, 'user_a', 'canonical_a', apiError), 'canonical_a');
  assert.equal(await requireOwnedInstance(pool, 'user_a', 'legacy_a', apiError), 'canonical_a');
  assert.equal(await requireOwnedInstance(pool, 'user_a', 'legacy_head_a', apiError), 'canonical_a');
  assert.equal(await resolveOwnedEmployeeInstanceId(pool, 'user_a', 'legacy_head_a', apiError), 'canonical_a');
  await assert.rejects(
    requireOwnedInstance(pool, 'user_a', 'legacy_b', apiError),
    (error) => error.code === 'agent_instance_not_found' && error.status === 404,
  );
  await assert.rejects(
    requireOwnedInstance(pool, 'user_a', 'broken_cross_user', apiError),
    (error) => error.code === 'agent_instance_not_found' && error.status === 404,
  );
  await assert.rejects(
    requireOwnedInstance(pool, 'user_a', 'cycle_a', apiError),
    (error) => error.code === 'agent_instance_not_found' && error.status === 404,
  );
  await assert.rejects(
    resolveOwnedEmployeeInstanceId(pool, 'user_a', 'cycle_a', apiError),
    (error) => error.code === 'agent_instance_not_found' && error.status === 404,
  );
});
