import assert from 'node:assert/strict';
import { test } from 'node:test';

import express from 'express';
import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { apiError } from '../src/errors.mjs';
import { registerUBuddyOrganizationEvolutionRoutes } from '../src/modules/organizationEvolution/index.mjs';

test('uBuddy organization evolution mines, activates, isolates, and auto-disables an assignment policy', async (t) => {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = database.adapters.createPg();
  const pool = new Pool();
  await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  await pool.query("INSERT INTO schema_migrations(filename) VALUES('024_cluster_cohort_ledger_contract.sql')");
  await migrate(pool);
  await migrate(pool);

  const app = express();
  app.use(express.json());
  const auth = (req, _res, next) => { req.auth = { user: { id: String(req.headers['x-test-user'] || 'owner_1') } }; next(); };
  const route = (handler) => async (req, res) => {
    try { await handler(req, res); } catch (error) {
      res.status(Number(error?.status || 500)).json({ error: { code: error?.code || 'error', message: error?.message || String(error) } });
    }
  };
  registerUBuddyOrganizationEvolutionRoutes({ app, pool, auth, route, apiError });
  const listener = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await pool.end();
  });
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  const request = async (path, { method = 'GET', body, user = 'owner_1' } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user, 'x-janus-social-capability': 'ubuddy-organization-evolution-v1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  const candidates = [
    { agentId: 'general_agent', agentInstanceId: 'general_1', performanceLevel: 'P1', queueDepth: 2 },
    { agentId: 'general_agent', agentInstanceId: 'general_2', performanceLevel: 'P3', queueDepth: 0 },
  ];
  for (let index = 1; index <= 3; index += 1) {
    const traceId = `trace_${index}`;
    const dispatch = await request('/api/ubuddy/organization-evolution/traces', { method: 'POST', body: {
      traceId, eventKind: 'dispatch', taskType: 'research', taskSignature: 'signature',
      idempotencyKey: `${traceId}:dispatch`, clientCreatedAt: new Date().toISOString(),
      payload: { version: 'UBUDDY_ORG_TRACE_V1', nodes: [{ localId: 'research', agentId: 'general_agent', agentInstanceId: 'general_1', isFinal: true }], candidates },
    } });
    assert.equal(dispatch.status, 201);
    if (index === 1) {
      const repeated = await request('/api/ubuddy/organization-evolution/traces', { method: 'POST', body: {
        traceId, eventKind: 'dispatch', taskType: 'research', taskSignature: 'signature',
        idempotencyKey: `${traceId}:dispatch`, clientCreatedAt: new Date().toISOString(),
        payload: { version: 'UBUDDY_ORG_TRACE_V1', nodes: [{ localId: 'research', agentId: 'general_agent', agentInstanceId: 'general_1', isFinal: true }], candidates },
      } });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.idempotent, true);
    }
    const terminal = await request('/api/ubuddy/organization-evolution/traces', { method: 'POST', body: {
      traceId, eventKind: 'terminal', taskType: 'research', taskSignature: 'signature',
      idempotencyKey: `${traceId}:terminal:failed`, clientCreatedAt: new Date().toISOString(),
      payload: { version: 'UBUDDY_ORG_TRACE_V1', status: 'failed', reworkCount: 0 },
    } });
    assert.equal(terminal.status, 201);
  }

  let overview = await request('/api/ubuddy/organization-evolution/overview');
  for (let attempt = 0; attempt < 50 && !overview.body.policies?.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    overview = await request('/api/ubuddy/organization-evolution/overview');
  }
  assert.equal(overview.status, 200);
  assert.equal(overview.body.traceCount, 6);
  assert.equal(overview.body.status, 'candidate_ready');
  assert.equal(overview.body.policies.length, 1);
  assert.equal(overview.body.activePolicy, null);
  const miningRuns = await pool.query(`SELECT COUNT(*) AS count FROM ubuddy_org_evolution_run_events
    WHERE owner_user_id='owner_1' AND event_kind='started'`);
  assert.ok(Number(miningRuns.rows[0].count) < 3, 'burst terminal events should be coalesced before policy mining');
  const policy = overview.body.policies[0];
  assert.equal(policy.playbook.assignmentRules[0].toAgentInstanceId, 'general_2');

  const isolated = await request('/api/ubuddy/organization-evolution/overview', { user: 'owner_2' });
  assert.equal(isolated.body.traceCount, 0);
  assert.equal(isolated.body.policies.length, 0);
  const crossUserActivation = await request(`/api/ubuddy/organization-evolution/policies/${policy.id}/activate`, {
    method: 'POST', user: 'owner_2', body: { commandId: 'cross_user_activate' },
  });
  assert.equal(crossUserActivation.status, 404);

  const commandId = 'activate_policy_once';
  const activated = await request(`/api/ubuddy/organization-evolution/policies/${policy.id}/activate`, {
    method: 'POST', body: { commandId },
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.activePolicy.policyVersionId, policy.id);
  const duplicate = await request(`/api/ubuddy/organization-evolution/policies/${policy.id}/activate`, {
    method: 'POST', body: { commandId },
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await pool.query('SELECT COUNT(*) AS count FROM ubuddy_org_activation_commands')).rows[0].count, 1);

  const active = await request('/api/ubuddy/organization-evolution/active-policy');
  assert.equal(active.body.activePolicy.policyVersionId, policy.id);
  const activeOverview = await request('/api/ubuddy/organization-evolution/overview');
  assert.equal(activeOverview.body.activePolicy.policyVersionId, policy.id);
  const health = await request('/api/ubuddy/organization-evolution/health', { method: 'POST', body: {
    policyVersionId: policy.id, traceId: 'live_trace', eventKind: 'contract_rejected',
    idempotencyKey: 'live_trace:contract', payload: { reason: 'validator rejected' },
  } });
  assert.equal(health.body.autoDisabled, true);
  const disabled = await request('/api/ubuddy/organization-evolution/active-policy');
  assert.equal(disabled.body.activePolicy, null);
});
