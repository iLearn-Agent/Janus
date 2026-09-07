import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { dataDir } from '../../paths.js';

export function cacheRemoteMessageFile({
  runtimeRoot = '', userId = '', fileId = '', filename = '', data = Buffer.alloc(0), sha256 = '', size = 0,
} = {}) {
  const bytes = Buffer.from(data || []);
  if (!bytes.length) throw new Error('附件内容为空。');
  if (Number(size || 0) && bytes.length !== Number(size)) throw new Error('附件大小校验失败。');
  const expectedSha256 = normalizeSha256(sha256);
  if (String(sha256 || '').trim() && !expectedSha256) throw new Error('附件校验信息无效。');
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 && expectedSha256 !== actualSha256) throw new Error('附件校验失败。');
  const target = remoteMessageFileCachePath({ runtimeRoot, userId, fileId, filename });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return { path: target, byteLength: bytes.length, sha256: actualSha256 };
}

export function cacheRemoteMessageFileFromPath({
  runtimeRoot = '', userId = '', fileId = '', filename = '', sourcePath = '', sha256 = '', size = 0,
} = {}) {
  const source = path.resolve(String(sourcePath || ''));
  if (!sourcePath || !fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('附件源文件不可用。');
  const stat = fs.statSync(source);
  if (size && stat.size !== Number(size)) throw new Error('附件大小校验失败。');
  const expectedSha256 = normalizeSha256(sha256);
  if (String(sha256 || '').trim() && !expectedSha256) throw new Error('附件校验信息无效。');
  if (expectedSha256 && hashFileSync(source) !== expectedSha256) throw new Error('附件校验失败。');
  const target = remoteMessageFileCachePath({ runtimeRoot, userId, fileId, filename });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    try {
      fs.linkSync(source, temporary);
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error?.code)) throw error;
      fs.copyFileSync(source, temporary);
    }
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return { path: target, byteLength: stat.size, sha256: expectedSha256 || hashFileSync(target) };
}

export function cachedRemoteMessageFile({
  runtimeRoot = '', userId = '', alternateUserIds = [], fileId = '', filename = '', sha256 = '', size = 0,
} = {}) {
  const expectedSha256 = normalizeSha256(sha256);
  if (String(sha256 || '').trim() && !expectedSha256) return null;
  const candidateUserIds = [...new Set([userId, ...alternateUserIds].map((value) => String(value || '').trim()).filter(Boolean))];
  for (const candidateUserId of candidateUserIds) {
    const preferred = remoteMessageFileCachePath({ runtimeRoot, userId: candidateUserId, fileId, filename });
    const directory = path.dirname(preferred);
    const candidates = [preferred, ...cachedFilesInDirectory(directory).filter((item) => item !== preferred)];
    for (const target of candidates) {
      if (!fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      if (!stat.isFile() || !stat.size) continue;
      if (Number(size || 0) && stat.size !== Number(size)) continue;
      const actualSha256 = expectedSha256 ? hashFileSync(target) : '';
      if (expectedSha256 && actualSha256 !== expectedSha256) continue;
      return { path: target, byteLength: stat.size, sha256: expectedSha256 || actualSha256 };
    }
  }
  return null;
}

export async function downloadRemoteMessageFile({
  runtimeRoot = '', socialRelay, describeFile, userId = '', workspaceId = '', fileId = '', name = '', filename = '',
  contentType = '', type = '', size = 0, sha256 = '', remoteFileKind = '', groupId = '',
} = {}) {
  const cleanFileId = String(fileId || '').trim();
  if (!cleanFileId) throw new Error('缺少附件 ID。');
  const safeName = safeRemoteMessageFilename(filename || name || cleanFileId);
  const canonicalCacheUserId = String(socialRelay?.remoteUserId?.(userId) || userId || '').trim();
  const cached = cachedRemoteMessageFile({
    runtimeRoot, userId: canonicalCacheUserId, alternateUserIds: [userId],
    fileId: cleanFileId, filename: safeName, sha256, size,
  });
  if (cached) return describeCachedFile({
    runtimeRoot, describeFile, userId, fileId: cleanFileId, safeName, contentType, type, size, cached,
  });
  if (!socialRelay?.connected?.()) return {
    unavailable: true,
    reason: 'offline',
    code: 'collaboration_file_offline',
    message: '此附件尚未缓存，需要连接通信服务器后获取。首次下载完成后即可离线使用。',
  };
  const largeTransfer = Number(size || 0) > 60 * 1024 * 1024;
  const download = (stream = false) => remoteFileKind === 'social'
    ? socialRelay.downloadSocialFile(cleanFileId, { workspaceId, stream })
    : remoteFileKind === 'chat_group'
      ? socialRelay.downloadChatGroupMessageFile(String(groupId || '').trim(), cleanFileId, { workspaceId, stream })
      : remoteFileKind === 'collaboration_group'
        ? socialRelay.downloadCollaborationGroupMessageFile(String(groupId || '').trim(), cleanFileId, { workspaceId, stream })
        : socialRelay.downloadCollaborationFile(cleanFileId, { workspaceId, stream });
  let stored;
  try {
    stored = largeTransfer
      ? await cacheRemoteMessageFileResponse({
        response: await retryRemoteFileDownload(() => download(true)), runtimeRoot, userId: canonicalCacheUserId,
        fileId: cleanFileId, filename: safeName, sha256, size,
      })
      : cacheRemoteMessageFile({
        runtimeRoot, userId: canonicalCacheUserId, fileId: cleanFileId,
        filename: safeName, data: Buffer.from(await retryRemoteFileDownload(() => download(false))), sha256, size,
      });
  } catch (error) {
    return remoteFileUnavailable(error);
  }
  return describeCachedFile({
    runtimeRoot, describeFile, userId, fileId: cleanFileId, safeName, contentType, type, size, cached: stored,
  });
}

function describeCachedFile({ runtimeRoot, describeFile, userId, fileId, safeName, contentType, type, size, cached }) {
  return describeFile(runtimeRoot, {
    id: fileId,
    name: safeName,
    filename: safeName,
    path: cached.path,
    content_type: contentType || type || 'application/octet-stream',
    type: type || contentType || 'application/octet-stream',
    size: Number(size || cached.byteLength),
    user_id: userId,
    owner_id: userId,
  }, userId);
}

function remoteMessageFileCachePath({ runtimeRoot = '', userId = '', fileId = '', filename = '' } = {}) {
  const cleanUserId = safeCacheSegment(userId || 'user');
  const cleanFileId = safeCacheSegment(fileId);
  if (!cleanFileId) throw new Error('缺少附件 ID。');
  return path.join(dataDir(runtimeRoot), 'collaboration-downloads', cleanUserId, cleanFileId, safeRemoteMessageFilename(filename || cleanFileId));
}

function safeCacheSegment(value = '') {
  const raw = String(value || '').trim();
  const clean = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 140);
  if (clean === raw) return clean;
  return clean ? `${clean}_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}` : '';
}

function safeRemoteMessageFilename(value = '') {
  return path.basename(String(value || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 180) || 'file';
}

function cachedFilesInDirectory(directory = '') {
  if (!directory || !fs.existsSync(directory)) return [];
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !/\.(?:tmp|download)$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function remoteFileUnavailable(error) {
  const status = Number(error?.status || 0);
  const sourceCode = String(error?.code || '').trim();
  const rawMessage = String(error?.message || error || '');
  if (status === 401) {
    return { unavailable: true, reason: 'authentication', code: 'collaboration_file_auth_required',
      message: '登录状态已失效，请重新登录后获取附件。' };
  }
  if (status === 426) {
    return { unavailable: true, reason: 'server_update', code: 'collaboration_file_server_update_required',
      message: '当前通信服务版本不支持这个附件，请更新并重启云端服务。' };
  }
  if (status === 404 || /_file_not_found$/.test(sourceCode)) {
    return { unavailable: true, reason: 'missing', code: 'collaboration_file_missing',
      message: '服务器上已找不到这个附件。若发送方本机仍有缓存，可以重新上传。' };
  }
  if (status === 403 || /_file_forbidden$/.test(sourceCode)) {
    return { unavailable: true, reason: 'forbidden', code: 'collaboration_file_forbidden',
      message: '当前账号没有权限获取这个附件。' };
  }
  if (status === 503 || sourceCode === 'large_file_object_unavailable' || sourceCode === 'large_file_object_size_mismatch') {
    return { unavailable: true, reason: 'storage', code: 'collaboration_file_storage_unavailable',
      message: '云端附件存储暂不可用，请联系管理员检查大文件存储目录。' };
  }
  if (/校验|完整性|sha-?256|hash|size mismatch|length/i.test(rawMessage)) {
    return { unavailable: true, reason: 'integrity', code: 'collaboration_file_integrity_failed',
      message: '附件完整性校验失败，文件可能损坏，请重新上传。' };
  }
  if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(sourceCode.toUpperCase())) {
    return { unavailable: true, reason: 'local_storage', code: 'collaboration_file_cache_write_failed',
      message: '附件已获取，但无法写入本机缓存，请检查磁盘空间和目录权限。' };
  }
  return { unavailable: true, reason: 'network', code: 'collaboration_file_network_unavailable',
    message: '暂时无法连接通信服务器获取附件，请检查网络后重试。' };
}

async function retryRemoteFileDownload(download, { maxAttempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, Number(maxAttempts || 1)); attempt += 1) {
    try {
      return await download();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !transientRemoteFileError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw lastError;
}

function transientRemoteFileError(error = null) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  return [408, 425, 429, 500, 502, 503, 504].includes(status)
    || ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)
    || /fetch failed|network error|socket hang up|connection (?:closed|reset|refused)|timed? out|temporarily unavailable|bad gateway|gateway timeout/i.test(message);
}

function normalizeSha256(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : '';
}

async function cacheRemoteMessageFileResponse({
  response, runtimeRoot = '', userId = '', fileId = '', filename = '', sha256 = '', size = 0,
} = {}) {
  if (!response?.body) throw new Error('附件下载响应为空。');
  const target = remoteMessageFileCachePath({ runtimeRoot, userId, fileId, filename });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.download`;
  const digest = crypto.createHash('sha256');
  let byteLength = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      byteLength += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const actualSha256 = digest.digest('hex');
    const expectedSha256 = normalizeSha256(sha256 || response.headers?.get?.('x-janus-file-sha256'));
    if (Number(size || 0) && byteLength !== Number(size)) throw new Error('附件下载长度校验失败。');
    if (expectedSha256 && actualSha256 !== expectedSha256) throw new Error('附件下载完整性校验失败。');
    fs.renameSync(temporary, target);
    return { path: target, byteLength, sha256: actualSha256 };
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function hashFileSync(filePath = '') {
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest('hex');
}
