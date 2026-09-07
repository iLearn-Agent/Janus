import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  createFileChangeSnapshotRunAsync,
  fileChangeSnapshotWorkerPoolSnapshot,
  terminateFileChangeSnapshotWorkers,
} from '../src/main/fileChangeSnapshots.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-file-snapshot-worker-'));
const workspace = path.join(root, 'project');
const previousMode = process.env.JANUS_FILE_SNAPSHOT_MODE;
try {
  await mkdir(workspace, { recursive: true });
  for (let index = 0; index < 80; index += 1) {
    await writeFile(path.join(workspace, `image-${index}.png`), Buffer.alloc(128 * 1024, index));
  }
  process.env.JANUS_FILE_SNAPSHOT_MODE = 'worker';
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => { heartbeatCount += 1; }, 1);
  const snapshot = await createFileChangeSnapshotRunAsync({ root, cwd: workspace, runId: 'worker-smoke' });
  clearInterval(heartbeat);
  assert.equal(snapshot.baselineMode, 'worker');
  assert.equal(snapshot.baselineFileCount, 80);
  assert.ok(snapshot.baselineBytes >= 80 * 128 * 1024);
  assert.ok(heartbeatCount > 0, 'baseline capture must yield the main event loop while the worker scans files');
  assert.equal(snapshot.coverage?.status, 'complete');
  snapshot.close();
  const oneShotWorker = new Worker(new URL('../src/main/fileChangeSnapshotWorker.js', import.meta.url), {
    workerData: {
      workspaceRoot: workspace,
      baselineRoot: path.join(root, 'one-shot-baseline'),
      maxFiles: 100,
      maxBytes: 32 * 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    },
  });
  const oneShotResult = await new Promise((resolve, reject) => {
    let response = null;
    oneShotWorker.once('message', (message) => { response = message; });
    oneShotWorker.once('error', reject);
    oneShotWorker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`One-shot snapshot worker exited with code ${code}.`));
      else resolve(response);
    });
  });
  assert.equal(oneShotResult?.ok, true);
  assert.equal(oneShotResult?.result?.baselines?.length, 80,
    'workerData callers must retain one-shot scan compatibility and exit naturally');
  const shutdownRun = createFileChangeSnapshotRunAsync({ root, cwd: workspace, runId: 'shutdown-during-scan' });
  assert.equal(fileChangeSnapshotWorkerPoolSnapshot().busy, 1);
  assert.equal(terminateFileChangeSnapshotWorkers(), 1);
  await assert.rejects(shutdownRun, (error) => error?.code === 'file_snapshot_worker_shutdown',
    'application shutdown must cancel an initializing scan instead of degrading and starting Codex afterward');
  assert.deepEqual(fileChangeSnapshotWorkerPoolSnapshot(), { total: 0, busy: 0 });
  const parallelRoots = await Promise.all(['a', 'b', 'c'].map(async (name) => {
    const directory = path.join(root, `parallel-${name}`);
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(directory, `asset-${index}.png`), Buffer.alloc(256 * 1024, index));
    }
    return directory;
  }));
  const parallelRuns = parallelRoots.map((directory, index) => createFileChangeSnapshotRunAsync({
    root, cwd: directory, runId: `parallel-${index}`,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fileChangeSnapshotWorkerPoolSnapshot().busy, 3,
    'three Agent turns must be able to scan baselines concurrently');
  const completedParallelRuns = await Promise.all(parallelRuns);
  completedParallelRuns.forEach((run) => run.close());
  assert.equal(fileChangeSnapshotWorkerPoolSnapshot().total, 3,
    'completed scans should leave reusable workers available for later Agent turns');
  assert.equal(terminateFileChangeSnapshotWorkers(), 3);
  assert.deepEqual(fileChangeSnapshotWorkerPoolSnapshot(), { total: 0, busy: 0 },
    'application shutdown must synchronously detach every reusable snapshot worker');
  console.log(`File change snapshot worker smoke passed (${snapshot.baselineDurationMs}ms, heartbeats ${heartbeatCount}).`);
} finally {
  terminateFileChangeSnapshotWorkers();
  if (previousMode === undefined) delete process.env.JANUS_FILE_SNAPSHOT_MODE;
  else process.env.JANUS_FILE_SNAPSHOT_MODE = previousMode;
  await rm(root, { recursive: true, force: true });
}
