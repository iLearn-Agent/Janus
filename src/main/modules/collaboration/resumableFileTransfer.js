import crypto from 'node:crypto';
import fs from 'node:fs';

export const FAST_REMOTE_FILE_BYTES = 60 * 1024 * 1024;
export const MAX_REMOTE_FILE_BYTES = 2 * 1024 * 1024 * 1024;

export async function sha256File(filePath = '') {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

export async function uploadResumableFileFromPath({
  socialRelay,
  sourcePath = '',
  fileId = '',
  scopeKind = '',
  scopeId = '',
  workspaceId = '',
  filename = 'file',
  contentType = 'application/octet-stream',
  size = 0,
  sha256 = '',
} = {}) {
  if (!socialRelay?.connected?.()) throw new Error('当前未连接通信服务器，无法上传大文件。');
  if (!await socialRelay.resumableFileTransferSupported()) {
    const error = new Error('当前通信服务尚未支持 60 MB 以上的大文件，请先更新并重启云端服务。');
    error.code = 'resumable_file_transfer_server_update_required';
    throw error;
  }
  const stat = fs.statSync(sourcePath);
  const fileSize = Number(size || stat.size);
  if (!stat.isFile() || stat.size !== fileSize) throw new Error('大文件源文件已发生变化，请重新选择。');
  if (fileSize <= FAST_REMOTE_FILE_BYTES || fileSize > MAX_REMOTE_FILE_BYTES) throw new Error('分片上传仅支持 60 MB 至 2 GB 的文件。');
  const digest = String(sha256 || await sha256File(sourcePath)).toLowerCase();
  const session = await retryTransientFileTransfer(() => socialRelay.createResumableFileUpload({
    fileId, scopeKind, scopeId, workspaceId, filename, contentType, size: fileSize, sha256: digest,
  }));
  if (session?.completed && session?.attachment?.remote_file_id) return session;
  const uploadId = String(session?.uploadId || '').trim();
  const chunkSize = Number(session?.chunkSize || 0);
  const chunkCount = Number(session?.chunkCount || 0);
  if (!uploadId || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(chunkCount) || chunkCount <= 0) {
    throw new Error('云端返回的大文件上传计划无效。');
  }
  const uploadedChunks = new Set((session.uploadedChunks || []).map(Number).filter(Number.isInteger));
  const handle = await fs.promises.open(sourcePath, 'r');
  try {
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (uploadedChunks.has(chunkIndex)) continue;
      const expectedBytes = Math.min(chunkSize, fileSize - chunkIndex * chunkSize);
      const data = Buffer.allocUnsafe(expectedBytes);
      let offset = 0;
      while (offset < expectedBytes) {
        const { bytesRead } = await handle.read(data, offset, expectedBytes - offset, chunkIndex * chunkSize + offset);
        if (!bytesRead) throw new Error('读取大文件分片时提前到达文件末尾。');
        offset += bytesRead;
      }
      const chunkSha256 = crypto.createHash('sha256').update(data).digest('hex');
      await retryTransientFileTransfer(() => socialRelay.uploadResumableFileChunk(uploadId, chunkIndex, {
        body: data,
        sha256: chunkSha256,
      }));
    }
  } finally {
    await handle.close();
  }
  const completed = await retryTransientFileTransfer(() => socialRelay.completeResumableFileUpload(uploadId));
  if (!completed?.attachment?.remote_file_id) throw new Error('大文件上传完成后未返回有效文件标识。');
  return completed;
}

export async function retryTransientFileTransfer(operation, { maxAttempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts || 1)); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !transientFileTransferError(error)) throw error;
      const baseMs = Math.max(1, Number(process.env.JANUS_FILE_TRANSFER_RETRY_BASE_MS || 250));
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, baseMs * attempt)));
    }
  }
  throw lastError;
}

function transientFileTransferError(error = null) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:closed|reset|refused)|timed? out|temporarily unavailable|bad gateway|gateway timeout/i.test(message);
}
