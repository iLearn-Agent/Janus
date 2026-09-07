#!/usr/bin/env node

import pg from 'pg';

import { createPostgresEvolutionWorker } from '../cloud/src/modules/evolution/worker.mjs';
import { queuePostgresPersonalEvolutionRun } from '../cloud/src/modules/evolution/personalQueue.mjs';
import { evolutionModelProviderStatus } from '../cloud/src/modules/evolution/modelProvider.mjs';
import { evolutionWorkerDecryptionKeyringFromEnv } from '../src/shared/evolution/index.js';

if (String(process.env.JANUS_ALLOW_REAL_EVOLUTION_VALIDATION || '').toLowerCase() !== 'true') {
  throw new Error('Set JANUS_ALLOW_REAL_EVOLUTION_VALIDATION=true to run against real collected Evidence.');
}
const databaseUrl = String(process.env.EVOLUTION_WORKER_DATABASE_URL || '').trim();
if (!databaseUrl) throw new Error('EVOLUTION_WORKER_DATABASE_URL is required.');
const provider = evolutionModelProviderStatus({ env: process.env });
if (!provider.available) throw new Error(`Evolution model provider is unavailable: ${provider.code}`);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10_000 });
try {
  const retryable = (await pool.query(`SELECT r.id,r.evidence_count FROM cloud_evolution_runs r
    JOIN cloud_evolution_jobs j ON j.run_id=r.id WHERE r.evolution_scope='personal'
      AND r.status='failed_retryable' AND j.status='failed_retryable'
      AND j.claimed_by='real-evidence-codex-validation' ORDER BY r.created_at DESC LIMIT 1`)).rows[0];
  let runId = retryable?.id || '';
  let evidenceCount = Number(retryable?.evidence_count || 0);
  if (retryable) {
    await pool.query("UPDATE cloud_evolution_jobs SET available_at=now() WHERE run_id=$1 AND status='failed_retryable'", [retryable.id]);
  } else {
    const selected = (await pool.query(`SELECT i.user_id,i.id,i.agent_family_id,COUNT(*)::int AS evidence_count
    FROM cloud_user_agent_instances_v3 i
    JOIN cloud_evolution_evidence e ON e.owner_user_id=i.user_id AND e.user_agent_instance_id=i.id
    JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
      AND u.evolution_scope='personal' AND u.consumer_id=i.id AND u.status IN ('available','released')
    WHERE i.status='active' AND i.sync_enabled=true AND i.personal_evolution_consent=true
      AND e.validation_status='validated' AND e.quarantine_reason='' AND e.historical_inactive=false
      AND e.personal_threshold_eligible=true
      AND NOT EXISTS (SELECT 1 FROM cloud_evolution_runs r WHERE r.user_agent_instance_id=i.id
        AND r.evolution_scope='personal' AND r.status IN ('queued','claimed','running','proposed','failed_retryable'))
    GROUP BY i.user_id,i.id,i.agent_family_id HAVING COUNT(*)>=5
    ORDER BY COUNT(*) DESC,i.id LIMIT 1`)).rows[0];
    if (!selected) throw new Error('No real Agent instance currently has enough available personal Evidence.');

    const queued = await queuePostgresPersonalEvolutionRun(pool, {
      userId: selected.user_id,
      agentInstanceId: selected.id,
      triggerKind: 'manual',
      keyring: evolutionWorkerDecryptionKeyringFromEnv(process.env),
    });
    if (queued.status !== 'queued') throw new Error(`Real Evidence validation run was not queued: ${queued.status}`);
    runId = queued.run.id;
    evidenceCount = Number(queued.run.evidenceCount || selected.evidence_count || 0);
  }

  const worker = createPostgresEvolutionWorker({ pool, env: process.env });
  const tick = await worker.tick({ workerId: 'real-evidence-codex-validation', limit: 1 });
  const completed = tick.completed.find((item) => item.runId === runId);
  if (!completed) throw new Error('The controlled Worker tick did not complete the queued validation run.');
  const stored = (await pool.query('SELECT status,evidence_count,error_code FROM cloud_evolution_runs WHERE id=$1', [runId])).rows[0];
  const output = {
    status: completed.status,
    storedStatus: stored?.status || '',
    evidenceCount: Number(stored?.evidence_count || evidenceCount || 0),
    errorCode: stored?.error_code || '',
    provider: { source: provider.source, model: provider.model, reviewModel: provider.reviewModel },
    candidateCreated: Boolean(completed.versionId),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (completed.status !== 'available' || !completed.versionId) process.exitCode = 2;
} finally {
  await pool.end();
}
