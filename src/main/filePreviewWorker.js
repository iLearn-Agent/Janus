import { parentPort, workerData } from 'node:worker_threads';

import { renderUploadedFile } from './files.js';

if (!parentPort) throw new Error('File preview worker requires a parent port.');

try {
  const delayMs = Math.max(0, Math.min(5_000, Number(process.env.JANUS_FILE_PREVIEW_WORKER_DELAY_MS || 0)));
  if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  const result = renderUploadedFile(
    String(workerData?.root || ''),
    workerData?.payload || {},
    workerData?.options || {},
  );
  parentPort.postMessage({ type: 'result', result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error: {
      name: String(error?.name || 'Error'),
      message: String(error?.message || error || 'File preview failed.'),
      stack: String(error?.stack || ''),
      code: String(error?.code || ''),
    },
  });
}
