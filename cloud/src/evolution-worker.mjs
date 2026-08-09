import { readConfig } from './config.mjs';
import { assertCloudDatabaseReady,assertDatabaseRole,createPgPool,migrate } from './db.mjs';
import { createPostgresEvolutionWorker, createPostgresLeadershipAuthority, createPostgresStage8Authority, evaluatePostgresVersionHealth } from './modules/evolution/index.mjs';
import { logDeprecatedEvolutionEnvironment } from '../../src/shared/evolution/index.js';

logDeprecatedEvolutionEnvironment({ processName: 'janus-evolution-worker' });
const config = readConfig(process.env, { requireJwt: false });
const pool = createPgPool(config.evolutionWorkerDatabaseUrl);
if (config.production) {
  await assertDatabaseRole(pool,'janus_evolution_worker');
  await assertCloudDatabaseReady(pool);
} else await migrate(pool);
const worker = createPostgresEvolutionWorker({ pool });
const stage8 = createPostgresStage8Authority({ pool });
const leadership = createPostgresLeadershipAuthority({ pool });
const intervalMs = Math.max(1000, Number(process.env.JANUS_EVOLUTION_WORKER_INTERVAL_MS || 15000));
const once = process.argv.includes('--once');

async function tick() {
  const historicalEvidenceBackfill = await stage8.backfillHistoricalEvidence({ limit: Number(process.env.JANUS_EVOLUTION_BACKFILL_BATCH_SIZE || 100) });
  const personal = await worker.tick({ limit: Number(process.env.JANUS_EVOLUTION_WORKER_BATCH_SIZE || 2) });
  const performance = await stage8.calculateAllPerformance();
  const leadershipBackfill = await leadership.backfillTaskHistory();
  const leadershipSnapshots = await leadership.calculateAll({ migrationBackfill: leadershipBackfill.inserted > 0 });
  const health = [];
  for (const snapshot of performance) {
    const instance = (await pool.query('SELECT user_id,active_personal_skill_version_id FROM cloud_user_agent_instances_v3 WHERE id=$1', [snapshot.agentInstanceId])).rows[0];
    if (!instance?.active_personal_skill_version_id) continue;
    health.push(await evaluatePostgresVersionHealth(pool, {
      userId: instance.user_id,
      agentInstanceId: snapshot.agentInstanceId,
      score: snapshot.score,
      failureRate: snapshot.failureRate,
      completedTaskCount: snapshot.completedTaskCount,
      inputHash: snapshot.inputHash,
    }));
  }
  const marketHealth = await stage8.evaluateMarketHealth();
  const canary = await stage8.reconcileMarketCanaries();
  let stage8Result = { status: 'unavailable', code: stage8.capabilities().cluster.code,
    performanceCount: performance.length, leadershipCount: leadershipSnapshots.length, leadershipBackfill, health, marketHealth, canary };
  if (stage8.capabilities().cluster.executionAvailable) {
    const cohorts = await stage8.refreshCohorts({ refreshPerformance: false });
    const scheduled = [];
    for (const cohort of await stage8.cohorts()) scheduled.push(await stage8.requestClusterRun({ cohortId: cohort.id, triggerKind: 'scheduled' }));
    const cluster = await stage8.tickClusterWorker({ limit: Number(process.env.JANUS_CLUSTER_WORKER_BATCH_SIZE || 2) });
    stage8Result = { status: 'ok', performanceCount: performance.length, leadershipCount: leadershipSnapshots.length, leadershipBackfill, health, marketHealth, canary, cohorts: cohorts.length, scheduled, cluster };
  }
  return { status: 'ok', authority: 'cloud', historicalEvidenceBackfill, personal, stage8: stage8Result };
}

if (once) {
  try { process.stdout.write(`${JSON.stringify(await tick(), null, 2)}\n`); }
  finally { await pool.end(); }
} else {
  const timer = setInterval(() => tick().catch((error) => console.error('[janus-evolution-worker]', error)), intervalMs);
  await tick();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    clearInterval(timer);
    pool.end().finally(() => process.exit(0));
  });
}
