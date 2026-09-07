import { Worker } from 'node:worker_threads';

let previewQueue = Promise.resolve();

export function renderUploadedFileOffMainThread(root, payload = {}, options = {}) {
  const task = previewQueue.catch(() => {}).then(() => runPreviewWorker(root, payload, options));
  previewQueue = task.catch(() => {});
  return task;
}

function runPreviewWorker(root, payload, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./filePreviewWorker.js', import.meta.url), {
      workerData: { root: String(root || ''), payload, options },
    });
    let settled = false;
    const timeout = setTimeout(() => finish(reject, Object.assign(new Error('文件预览生成超时。'), {
      code: 'FILE_PREVIEW_TIMEOUT',
    })), 120_000);
    timeout.unref?.();

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
      void worker.terminate().catch(() => {});
    };

    worker.on('message', (message = {}) => {
      if (message.type === 'result') finish(resolve, message.result);
      else if (message.type === 'error') finish(reject, restorePreviewWorkerError(message.error));
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(reject, Object.assign(new Error(`File preview worker exited with code ${code}.`), {
        code: 'FILE_PREVIEW_WORKER_EXIT',
      }));
      else if (!settled) finish(reject, Object.assign(new Error('File preview worker exited without a result.'), {
        code: 'FILE_PREVIEW_WORKER_EMPTY_RESULT',
      }));
    });
  });
}

function restorePreviewWorkerError(payload = {}) {
  const error = new Error(String(payload.message || 'File preview failed.'));
  error.name = String(payload.name || 'Error');
  if (payload.stack) error.stack = String(payload.stack);
  if (payload.code) error.code = String(payload.code);
  return error;
}
