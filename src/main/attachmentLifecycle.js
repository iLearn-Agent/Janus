import fs from 'node:fs';
import path from 'node:path';

import { all, run } from './db.js';
import { dataDir } from './paths.js';
import { safeJsonParse } from './utils.js';

export function deleteSessionManagedAttachments(root, db, sessionId) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return { deletedFiles: 0, retainedFiles: 0, deletedPaths: [] };

  const sessionRows = all(db, 'SELECT metadata_json FROM messages WHERE session_id = ?', [cleanSessionId]);
  const otherRows = all(
    db,
    `SELECT m.metadata_json
     FROM messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE m.session_id != ? AND s.status != 'deleted'`,
    [cleanSessionId],
  );
  const candidates = managedAttachmentTargets(root, sessionRows);
  const referencedElsewhere = new Set(managedAttachmentTargets(root, otherRows));
  const deletedPaths = [];
  let retainedFiles = 0;

  for (const target of candidates) {
    if (referencedElsewhere.has(target)) {
      retainedFiles += 1;
      continue;
    }
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removeEmptyUploadParents(root, path.dirname(target));
    }
    const localPath = path.relative(root, target).replaceAll('\\', '/');
    run(db, 'DELETE FROM cloud_file_manifest WHERE local_path = ?', [localPath]);
    deletedPaths.push(localPath);
  }

  run(db, "DELETE FROM cloud_file_refs WHERE session_id = ? AND source_kind = 'attachment'", [cleanSessionId]);
  return { deletedFiles: deletedPaths.length, retainedFiles, deletedPaths };
}

function managedAttachmentTargets(root, rows = []) {
  const targets = new Set();
  for (const row of rows) {
    const metadata = safeJsonParse(row.metadata_json, {});
    for (const attachments of managedAttachmentCollections(metadata)) {
      for (const attachment of attachments) {
        const target = managedAttachmentTarget(root, attachment);
        if (target) targets.add(target);
      }
    }
  }
  return targets;
}

function managedAttachmentCollections(metadata = {}) {
  return [
    metadata.attachments,
    metadata.externalDelegationDeliveryDraft?.attachments,
    metadata.externalDelegationSubmittedSnapshot?.attachments,
  ].filter(Array.isArray);
}

function managedAttachmentTarget(root, attachment = {}) {
  const uploadsRoot = path.resolve(dataDir(root), 'uploads');
  const candidates = [
    attachment.path,
    attachment.relative_path,
    attachment.relativePath,
  ].filter(Boolean);
  const ownerId = safePathSegment(attachment.user_id || attachment.owner_id || attachment.userId || attachment.ownerId || '');
  const uploadId = safePathSegment(attachment.id || '');
  const filename = safeFilename(attachment.filename || attachment.name || '');
  if (ownerId && uploadId && filename) candidates.push(path.join(dataDir(root), 'uploads', ownerId, uploadId, filename));

  for (const candidate of candidates) {
    const target = path.resolve(path.isAbsolute(String(candidate)) ? String(candidate) : path.join(root, String(candidate)));
    if (target.startsWith(`${uploadsRoot}${path.sep}`)) return target;
  }
  return '';
}

function removeEmptyUploadParents(root, startDir) {
  const uploadsRoot = path.resolve(dataDir(root), 'uploads');
  let current = path.resolve(startDir);
  while (current.startsWith(`${uploadsRoot}${path.sep}`)) {
    try {
      if (fs.readdirSync(current).length) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function safePathSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function safeFilename(value) {
  return path.basename(String(value || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 180);
}
