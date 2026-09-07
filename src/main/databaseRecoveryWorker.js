import { parentPort, workerData } from 'node:worker_threads';

import { repairDatabase } from './databaseRecovery.js';

if (!parentPort) throw new Error('Database recovery worker requires a parent port.');

try {
  const result = repairDatabase(String(workerData?.root || ''), {
    appVersion: String(workerData?.appVersion || ''),
    onProgress(progress) {
      parentPort.postMessage({ type: 'progress', progress });
      const delayMs = Math.max(0, Math.min(1_000, Number(workerData?.progressDelayMs || 0)));
      if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    },
  });
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error: {
      name: String(error?.name || 'Error'),
      message: String(error?.message || error || 'Database repair failed.'),
      stack: String(error?.stack || ''),
      code: String(error?.code || ''),
      phase: String(error?.phase || ''),
      migrationId: String(error?.migrationId || ''),
      backupId: String(error?.backupId || ''),
      recoveryEligible: Boolean(error?.recoveryEligible),
    },
  });
}
