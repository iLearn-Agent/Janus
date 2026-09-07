import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { uploadedFileTarget } from '../../../files.js';
import { cacheRemoteMessageFile, cacheRemoteMessageFileFromPath } from '../remoteMessageFileCache.js';
import {
  FAST_REMOTE_FILE_BYTES,
  MAX_REMOTE_FILE_BYTES,
  sha256File,
  uploadResumableFileFromPath,
} from '../resumableFileTransfer.js';

const MAX_MESSAGE_FILE_BYTES = MAX_REMOTE_FILE_BYTES;

export async function uploadRemoteMessageAttachments({
  runtimeRoot = '', socialRelay, userId = '', scopeKind = 'social', scopeId = '', accountWorkspaceId = '', attachments = [],
} = {}) {
  const uploaded = [];
  for (const attachment of uniqueMessageAttachments(attachments).slice(0, 20)) {
    if (attachment?.remote_file_id || attachment?.remoteFileId) {
      uploaded.push(publicRemoteMessageAttachment(attachment, attachment.remote_file_kind || attachment.remoteFileKind || scopeKind));
      continue;
    }
    let sourcePath = '';
    try {
      sourcePath = uploadedFileTarget(runtimeRoot, attachment, userId);
    } catch {
      sourcePath = '';
    }
    if (!sourcePath) throw new Error(`附件“${attachment?.name || attachment?.filename || 'file'}”的本地文件已经不可用，消息未发送。`);
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error(`附件“${attachment?.name || attachment?.filename || 'file'}”不是有效文件，消息未发送。`);
    if (stat.size > MAX_MESSAGE_FILE_BYTES) throw new Error(`附件“${attachment?.name || attachment?.filename || 'file'}”超过 2 GB，消息未发送。`);
    const data = stat.size <= FAST_REMOTE_FILE_BYTES ? fs.readFileSync(sourcePath) : null;
    const sha256 = data
      ? crypto.createHash('sha256').update(data).digest('hex')
      : await sha256File(sourcePath);
    const fileId = `message_file_${crypto.createHash('sha256').update(`${accountWorkspaceId || 'workspace_personal'}:${scopeKind}:${scopeId}:${userId}:${sha256}`).digest('hex').slice(0, 40)}`;
    const request = {
      filename: safeMessageFilename(attachment?.filename || attachment?.name || path.basename(sourcePath)),
      contentType: attachment?.content_type || attachment?.type || 'application/octet-stream',
      size: stat.size,
      sha256,
      workspaceId: accountWorkspaceId || 'workspace_personal',
    };
    const response = stat.size > FAST_REMOTE_FILE_BYTES
      ? await uploadResumableFileFromPath({
        socialRelay, sourcePath, fileId, scopeKind, scopeId,
        workspaceId: request.workspaceId, filename: request.filename, contentType: request.contentType,
        size: stat.size, sha256,
      })
      : scopeKind === 'collaboration_group'
        ? await socialRelay.uploadCollaborationGroupMessageFile(scopeId, fileId, { ...request, body: data })
        : scopeKind === 'chat_group'
          ? await socialRelay.uploadChatGroupMessageFile(scopeId, fileId, { ...request, body: data })
          : await socialRelay.uploadSocialFile(fileId, { ...request, body: data, recipientId: scopeId });
    if (!response?.attachment?.remote_file_id) throw new Error(`附件“${attachment?.name || attachment?.filename || 'file'}”上传后未返回有效文件标识，消息未发送。`);
    const cachePayload = {
      runtimeRoot, userId: socialRelay.remoteUserId?.(userId) || userId, fileId: response.attachment.remote_file_id,
      filename: response.attachment.filename || response.attachment.name || request.filename,
      sha256: response.attachment.sha256 || sha256,
    };
    if (data) cacheRemoteMessageFile({ ...cachePayload, data });
    else cacheRemoteMessageFileFromPath({ ...cachePayload, sourcePath, size: stat.size });
    uploaded.push(publicRemoteMessageAttachment({ ...attachment, ...response.attachment }, scopeKind));
  }
  return uploaded;
}

export function publicRemoteMessageAttachment(attachment = {}, remoteFileKind = '') {
  const name = safeMessageFilename(attachment.filename || attachment.name || 'file');
  return {
    id: String(attachment.remote_file_id || attachment.remoteFileId || attachment.id || ''),
    remote_file_id: String(attachment.remote_file_id || attachment.remoteFileId || ''),
    remote_file_kind: String(remoteFileKind || attachment.remote_file_kind || attachment.remoteFileKind || ''),
    group_id: String(attachment.group_id || attachment.groupId || ''),
    name,
    filename: name,
    kind: String(attachment.kind || ''),
    type: String(attachment.type || attachment.content_type || '').slice(0, 200),
    content_type: String(attachment.content_type || attachment.type || '').slice(0, 200),
    size: Math.max(0, Number(attachment.size || 0) || 0),
    sha256: String(attachment.sha256 || '').slice(0, 128),
  };
}

function uniqueMessageAttachments(attachments = []) {
  const seen = new Set();
  return (Array.isArray(attachments) ? attachments : []).filter((attachment) => {
    const key = String(attachment?.remote_file_id || attachment?.remoteFileId || attachment?.id || `${attachment?.name || attachment?.filename || ''}:${attachment?.size || 0}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeMessageFilename(value = '') {
  return path.basename(String(value || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 180) || 'file';
}
