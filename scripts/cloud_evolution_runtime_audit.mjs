#!/usr/bin/env node

import pg from 'pg';

import { evolutionModelProviderStatus } from '../cloud/src/modules/evolution/modelProvider.mjs';

const databaseUrl = String(process.env.EVOLUTION_WORKER_DATABASE_URL || '').trim();
if (!databaseUrl) throw new Error('EVOLUTION_WORKER_DATABASE_URL is required.');
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
});

try {
  const [identity, canary, versions, runs, jobs] = await Promise.all([
    pool.query("SELECT current_user,pg_has_role(current_user,'janus_evolution_worker','member') AS worker_role"),
    pool.query(`SELECT
      COUNT(*) FILTER (WHERE o.status='active')::int AS active,
      COUNT(*) FILTER (WHERE o.status='withdrawn')::int AS opted_out,
      COUNT(*) FILTER (WHERE o.policy_version='market_canary_real_user_default_on_v2')::int AS policy_v2,
      COUNT(*) FILTER (WHERE i.status='active' AND i.sync_enabled=true AND i.cluster_contribution_consent=true
        AND COALESCE(p.enabled,true)=true)::int AS eligible
      FROM cloud_user_agent_instances_v3 i
      LEFT JOIN cloud_user_evolution_preferences p ON p.user_id=i.user_id
      LEFT JOIN cloud_market_canary_opt_ins o ON o.user_id=i.user_id AND o.user_agent_instance_id=i.id`),
    pool.query("SELECT COUNT(*)::int AS released FROM cloud_market_agent_versions WHERE status='released'"),
    pool.query(`SELECT status,COUNT(*)::int AS count FROM cloud_evolution_runs
      WHERE updated_at>=now()-interval '24 hours' GROUP BY status ORDER BY status`),
    pool.query(`SELECT status,COUNT(*)::int AS count FROM cloud_evolution_jobs
      WHERE updated_at>=now()-interval '24 hours' GROUP BY status ORDER BY status`),
  ]);
  process.stdout.write(`${JSON.stringify({
    ready: true,
    database: { workerRole: Boolean(identity.rows[0]?.worker_role) },
    modelProvider: evolutionModelProviderStatus({ env: process.env }),
    canary: canary.rows[0],
    market: versions.rows[0],
    recentRuns: runs.rows,
    recentJobs: jobs.rows,
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
