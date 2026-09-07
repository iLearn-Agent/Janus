import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { describeFile, renderUploadedFile, uploadFileFromPath } from '../src/main/files.js';
import { uploadRemoteMessageAttachments } from '../src/main/modules/collaboration/application/messageFileTransfer.js';
import { syncDelegationWorkspaceMessages } from '../src/main/modules/collaboration/application/delegationWorkspaceMessages.js';
import { uploadCollaborationTaskAttachments } from '../src/main/modules/collaboration/infrastructure/delegationWorkspaceFiles.js';
import { downloadRemoteMessageFile } from '../src/main/modules/collaboration/remoteMessageFileCache.js';
import { ALL_ATTACHMENT_EXTENSIONS } from '../src/renderer/app/constants.js';
import { renderPreviewBody } from '../src/renderer/app/components/overlays.js';
import { renderMessageAttachmentCards } from '../src/renderer/app/views/chatView.js';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-attachment-format-matrix-'));
const sourceDir = path.join(runtimeRoot, 'fixtures');
const senderUserId = 'attachment-sender';
const receiverUserId = 'attachment-receiver';
fs.mkdirSync(sourceDir, { recursive: true });

try {
  createFixtures(sourceDir);
  const fixtureNames = [
    'sample.doc', 'sample.docx', 'sample.py', 'sample.cpp', 'sample.xlsx',
    'sample.ppt', 'sample.pptx', 'sample.pdf', 'sample.md', 'sample.png',
    'sample.zip', 'sample.7z', 'sample.rar', 'sample.tar', 'sample.gz', 'sample.bz2', 'sample.xz',
    'sample.exe', 'sample.msi', 'sample.dmg', 'sample.pkg', 'sample.apk', 'sample.appimage',
    'sample.deb', 'sample.rpm', 'sample.iso',
  ];
  for (const filename of fixtureNames) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    assert.equal(ALL_ATTACHMENT_EXTENSIONS.has(ext), true, `${filename} must be selectable in every normal attachment composer`);
  }

  const uploaded = fixtureNames.map((filename) => uploadFileFromPath(runtimeRoot, {
    sourcePath: path.join(sourceDir, filename),
    filename,
  }, senderUserId));
  const localPreviews = new Map(uploaded.map((file) => [file.filename, renderUploadedFile(runtimeRoot, file)]));
  assertPreviewKinds(localPreviews);
  for (const [filename, preview] of localPreviews) {
    const body = renderPreviewBody(preview);
    assert.ok(body && !body.includes('该文件格式暂不支持内嵌预览'), `${filename} must have an inline or structured preview`);
  }
  const disguisedDocPath = path.join(sourceDir, 'disguised.doc');
  fs.writeFileSync(disguisedDocPath, 'This is plain text renamed to .doc.');
  const disguisedDoc = uploadFileFromPath(runtimeRoot, { sourcePath: disguisedDocPath, filename: 'disguised.doc' }, senderUserId);
  const disguisedPreview = renderUploadedFile(runtimeRoot, disguisedDoc);
  assert.equal(disguisedPreview.preview_error_code, 'office_format_mismatch');
  assert.match(disguisedPreview.text, /内容与扩展名不匹配|直接改名/);
  assert.doesNotMatch(disguisedPreview.text, /Install LibreOffice\/WPS\/Office/);

  const remoteStore = new Map();
  const relay = createRelay(remoteStore);
  const contexts = [
    { label: '私聊', scopeKind: 'social', scopeId: 'friend-user', remoteFileKind: 'social' },
    { label: '群聊', scopeKind: 'chat_group', scopeId: 'chat-group-1', remoteFileKind: 'chat_group' },
    { label: '工作群', scopeKind: 'collaboration_group', scopeId: 'work-group-1', remoteFileKind: 'collaboration_group' },
  ];
  for (const context of contexts) {
    const remoteAttachments = [];
    for (const batch of batchesOf(uploaded, 20)) {
      remoteAttachments.push(...await uploadRemoteMessageAttachments({
        runtimeRoot,
        socialRelay: relay,
        userId: senderUserId,
        scopeKind: context.scopeKind,
        scopeId: context.scopeId,
        accountWorkspaceId: 'workspace-personal',
        attachments: batch,
      }));
    }
    assert.equal(remoteAttachments.length, fixtureNames.length, `${context.label} must upload every fixture`);
    for (const attachment of remoteAttachments) {
      assert.equal(attachment.remote_file_kind, context.remoteFileKind);
      const downloaded = await downloadRemoteMessageFile({
        runtimeRoot,
        socialRelay: relay,
        describeFile,
        userId: receiverUserId,
        workspaceId: 'workspace-personal',
        fileId: attachment.remote_file_id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        type: attachment.type,
        size: attachment.size,
        sha256: attachment.sha256,
        remoteFileKind: context.remoteFileKind,
        groupId: context.scopeId,
      });
      assert.ok(downloaded.path && fs.existsSync(downloaded.path), `${context.label}/${attachment.filename} must download locally`);
      const preview = renderUploadedFile(runtimeRoot, downloaded);
      assert.ok(renderPreviewBody(preview), `${context.label}/${attachment.filename} must preview after download`);
    }
    const cards = renderMessageAttachmentCards(remoteAttachments);
    for (const filename of fixtureNames) assert.match(cards, new RegExp(filename.replace('.', '\\.')));
    assert.match(cards, /compact-message-image is-remote-placeholder/);
    for (const visualKind of ['word', 'code', 'excel', 'ppt', 'pdf', 'text', 'archive', 'installer']) {
      assert.match(cards, new RegExp(`attachment-kind-${visualKind}`), `${context.label} must render the ${visualKind} file badge`);
    }
  }

  const taskAttachments = [];
  for (const batch of batchesOf(uploaded, 20)) {
    taskAttachments.push(...await uploadCollaborationTaskAttachments({
      runtimeRoot,
      socialRelay: relay,
      delegationId: 'delegation-1',
      userId: senderUserId,
      workspaceId: 'workspace-personal',
      attachments: batch,
    }));
  }
  assert.equal(taskAttachments.length, fixtureNames.length, 'uBuddy task attachments must upload every fixture');
  for (const attachment of taskAttachments) {
    const downloaded = await downloadRemoteMessageFile({
      runtimeRoot,
      socialRelay: relay,
      describeFile,
      userId: receiverUserId,
      workspaceId: 'workspace-personal',
      fileId: attachment.remote_file_id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      type: attachment.type,
      size: attachment.size,
      sha256: attachment.sha256,
      remoteFileKind: 'collaboration_task',
    });
    assert.ok(downloaded.path && renderPreviewBody(renderUploadedFile(runtimeRoot, downloaded)), `uBuddy/${attachment.filename} must download and preview`);
  }
  const recoveredGroupBytes = Buffer.from('# recovered group workspace delivery\n');
  const recoveredGroupSha256 = crypto.createHash('sha256').update(recoveredGroupBytes).digest('hex');
  const recoveredGroupRelay = {
    ...relay,
    collaborationGroupWorkspace: async () => ({ files: [{
      id: 'group-file-recovered-draft', relativePath: 'deliverables/recovered-draft.md',
      filename: 'recovered-draft.md', size: recoveredGroupBytes.length, sha256: recoveredGroupSha256,
    }] }),
    downloadCollaborationGroupWorkspaceFile: async (_groupId, fileId) => {
      assert.equal(fileId, 'group-file-recovered-draft');
      return recoveredGroupBytes;
    },
  };
  const recoveredTaskAttachments = await uploadCollaborationTaskAttachments({
    runtimeRoot,
    socialRelay: recoveredGroupRelay,
    delegationId: 'delegation-recovered-group-file',
    groupId: 'collab_group_recovery',
    userId: senderUserId,
    workspaceId: 'workspace-personal',
    attachments: [{
      id: 'missing-local-upload', name: 'recovered-draft.md', filename: 'recovered-draft.md',
      type: 'text/markdown', size: recoveredGroupBytes.length, group_id: 'collab_group_recovery',
      source_path: 'C:\\Users\\owner\\.janus\\data\\task-group-workspaces\\owner\\collab_group_recovery\\deliverables\\recovered-draft.md',
    }],
  });
  assert.equal(recoveredTaskAttachments.length, 1);
  assert.equal(requiredRemoteBytes(remoteStore, recoveredTaskAttachments[0].remote_file_id).toString(), recoveredGroupBytes.toString(),
    'a group delivery must recover from the synchronized workspace when its original local path is unavailable');

  let synchronizedWorkspacePayload = null;
  await syncDelegationWorkspaceMessages({
    sendDelegationWorkspaceMessage: async (_delegationId, payload) => { synchronizedWorkspacePayload = payload; },
  }, 'delegation-sync-sanitized', 'session-sync-sanitized', [{
    id: 'message-sync-sanitized', role: 'system', content: 'generated file',
    metadata: {
      delegationId: 'delegation-sync-sanitized', privateTaskWorkspace: true, workspaceEpoch: 'epoch-sync-sanitized',
      attachments: [{
        id: 'upload-sync-sanitized', name: 'draft.md', path: '/private/uploads/draft.md',
        source_path: '/private/task-group/draft.md', workspace_relative_path: 'deliverables/draft.md',
      }],
    },
  }], 'epoch-sync-sanitized', 'workspace-personal');
  const synchronizedAttachment = synchronizedWorkspacePayload?.metadata?.attachments?.[0] || {};
  assert.equal(synchronizedAttachment.path, undefined);
  assert.equal(synchronizedAttachment.source_path, undefined);
  assert.equal(synchronizedAttachment.workspace_relative_path, 'deliverables/draft.md',
    'workspace sync must retain a portable task-relative identity without leaking local absolute paths');
  let transientTaskUploadAttempts = 0;
  const stableTaskUpload = relay.uploadCollaborationFile;
  const transientTaskRelay = {
    ...relay,
    async uploadCollaborationFile(...args) {
      transientTaskUploadAttempts += 1;
      if (transientTaskUploadAttempts === 1) throw Object.assign(new Error('temporary upload reset'), { code: 'ECONNRESET' });
      return stableTaskUpload(...args);
    },
  };
  await uploadCollaborationTaskAttachments({
    runtimeRoot,
    socialRelay: transientTaskRelay,
    delegationId: 'delegation-transient-upload',
    userId: senderUserId,
    workspaceId: 'workspace-personal',
    attachments: [uploaded[0]],
  });
  assert.equal(transientTaskUploadAttempts, 2, 'a transient task-file PUT must retry before failing submission');
  let activeTaskUploads = 0;
  let peakTaskUploads = 0;
  const parallelTaskRelay = {
    ...relay,
    async uploadCollaborationFile(...args) {
      activeTaskUploads += 1;
      peakTaskUploads = Math.max(peakTaskUploads, activeTaskUploads);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await stableTaskUpload(...args);
      } finally {
        activeTaskUploads -= 1;
      }
    },
  };
  await uploadCollaborationTaskAttachments({
    runtimeRoot,
    socialRelay: parallelTaskRelay,
    delegationId: 'delegation-parallel-upload',
    userId: senderUserId,
    workspaceId: 'workspace-personal',
    attachments: uploaded.slice(0, 8),
  });
  assert.ok(peakTaskUploads >= 2, 'independent small task files must upload concurrently instead of multiplying network latency');
  const emptyPath = path.join(sourceDir, 'empty.md');
  fs.writeFileSync(emptyPath, '');
  const remoteCountBeforeEmpty = remoteStore.size;
  await assert.rejects(
    uploadCollaborationTaskAttachments({
      runtimeRoot,
      socialRelay: relay,
      delegationId: 'delegation-empty',
      userId: senderUserId,
      workspaceId: 'workspace-personal',
      attachments: [{ name: 'empty.md', path: emptyPath }],
    }),
    /空文件/,
  );
  assert.equal(remoteStore.size, remoteCountBeforeEmpty, 'invalid task files must be rejected before any remote upload');

  const messageSendSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
  assert.match(messageSendSource, /api\.secretaryChat\(\{[\s\S]*?attachments,/);
  assert.match(messageSendSource, /api\.sendChat\(\{[\s\S]*?attachments,/);
  const chatRunSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/chatRunController.js', import.meta.url), 'utf8');
  assert.match(chatRunSource, /bindFileAction\('\[data-preview-file\]'/,
    'preview actions must be wired in the main chat controller, not only the network panel');
  const rendererSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
  assert.match(rendererSource, /hydrateRemoteImageAttachmentThumbnails\(document\)/);

  process.stdout.write('Attachment format and conversation matrix smoke passed.\n');
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

function assertPreviewKinds(previews) {
  assert.equal(previews.get('sample.doc')?.kind, 'doc');
  assert.equal(previews.get('sample.md')?.kind, 'markdown');
  assert.equal(previews.get('sample.py')?.kind, 'text');
  assert.equal(previews.get('sample.cpp')?.kind, 'text');
  assert.equal(previews.get('sample.png')?.kind, 'image');
  assert.equal(previews.get('sample.pdf')?.kind, 'pdf');
  assert.equal(previews.get('sample.docx')?.kind, 'docx');
  assert.equal(previews.get('sample.xlsx')?.kind, 'xlsx');
  assert.equal(previews.get('sample.ppt')?.kind, 'ppt');
  assert.equal(previews.get('sample.pptx')?.kind, 'pptx');
  assert.equal(previews.get('sample.zip')?.kind, 'archive');
  assert.equal(previews.get('sample.exe')?.kind, 'installer');
  for (const filename of ['sample.7z', 'sample.rar', 'sample.tar', 'sample.gz', 'sample.bz2', 'sample.xz']) {
    assert.equal(previews.get(filename)?.kind, 'archive');
  }
  for (const filename of ['sample.msi', 'sample.dmg', 'sample.pkg', 'sample.apk', 'sample.appimage', 'sample.deb', 'sample.rpm', 'sample.iso']) {
    assert.equal(previews.get(filename)?.kind, 'installer');
  }
}

function createRelay(store) {
  const upload = (remoteFileKind, groupId = '') => async (fileId, request) => {
    store.set(fileId, Buffer.from(request.body));
    return { attachment: {
      remote_file_id: fileId,
      remote_file_kind: remoteFileKind,
      group_id: groupId,
      filename: request.filename,
      name: request.filename,
      content_type: request.contentType,
      type: request.contentType,
      size: request.size,
      sha256: request.sha256,
    } };
  };
  return {
    connected: () => true,
    uploadSocialFile: async (fileId, request) => upload('social')(fileId, request),
    uploadChatGroupMessageFile: async (groupId, fileId, request) => upload('chat_group', groupId)(fileId, request),
    uploadCollaborationGroupMessageFile: async (groupId, fileId, request) => upload('collaboration_group', groupId)(fileId, request),
    uploadCollaborationFile: async (_delegationId, fileId, request) => upload('collaboration_task')(fileId, request),
    downloadSocialFile: async (fileId) => requiredRemoteBytes(store, fileId),
    downloadChatGroupMessageFile: async (_groupId, fileId) => requiredRemoteBytes(store, fileId),
    downloadCollaborationGroupMessageFile: async (_groupId, fileId) => requiredRemoteBytes(store, fileId),
    downloadCollaborationFile: async (fileId) => requiredRemoteBytes(store, fileId),
  };
}

function requiredRemoteBytes(store, fileId) {
  const bytes = store.get(fileId);
  if (!bytes) throw new Error(`missing remote fixture ${fileId}`);
  return bytes;
}

function batchesOf(items = [], size = 20) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function createFixtures(directory) {
  for (const extension of ['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz']) {
    fs.writeFileSync(path.join(directory, `sample.${extension}`), Buffer.from(`safe ${extension} archive fixture`));
  }
  for (const extension of ['exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso']) {
    fs.writeFileSync(path.join(directory, `sample.${extension}`), Buffer.from(`safe ${extension} installer fixture`));
  }
  fs.writeFileSync(path.join(directory, 'sample.md'), '# Attachment matrix\n\nMarkdown preview.\n');
  fs.writeFileSync(path.join(directory, 'sample.py'), 'print("python attachment")\n');
  fs.writeFileSync(path.join(directory, 'sample.cpp'), '#include <iostream>\nint main(){std::cout << "cpp attachment";}\n');
  fs.writeFileSync(path.join(directory, 'word.html'), '<html><body><h1>Word attachment</h1><p>Preview matrix.</p></body></html>');
  const python = spawnSync('python3', ['-c', String.raw`
import sys
import zipfile
from pathlib import Path
import fitz
from PIL import Image
from pptx import Presentation

root = Path(sys.argv[1])
Image.new('RGB', (96, 64), (68, 120, 220)).save(root / 'sample.png')
pdf = fitz.open()
page = pdf.new_page()
page.insert_text((72, 72), 'PDF attachment matrix')
pdf.save(root / 'sample.pdf')
ppt = Presentation()
slide = ppt.slides.add_slide(ppt.slide_layouts[1])
slide.shapes.title.text = 'PPT attachment matrix'
slide.placeholders[1].text = 'Preview and transport'
ppt.save(root / 'sample.pptx')
with zipfile.ZipFile(root / 'sample.xlsx', 'w', zipfile.ZIP_DEFLATED) as book:
    book.writestr('[Content_Types].xml', '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''')
    book.writestr('_rels/.rels', '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''')
    book.writestr('xl/workbook.xml', '''<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Matrix" sheetId="1" r:id="rId1"/></sheets>
</workbook>''')
    book.writestr('xl/_rels/workbook.xml.rels', '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>''')
    book.writestr('xl/worksheets/sheet1.xml', '''<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row>
  <row r="2"><c r="A2" t="inlineStr"><is><t>alpha</t></is></c><c r="B2"><v>1</v></c></row>
</sheetData></worksheet>''')
`, directory], { encoding: 'utf8' });
  if (python.status !== 0) throw new Error(`Unable to create binary attachment fixtures: ${python.stderr || python.stdout}`);
  convertOffice(directory, 'word.html', 'docx');
  fs.renameSync(path.join(directory, 'word.docx'), path.join(directory, 'sample.docx'));
  convertOffice(directory, 'word.html', 'doc');
  fs.renameSync(path.join(directory, 'word.doc'), path.join(directory, 'sample.doc'));
  convertOffice(directory, 'sample.pptx', 'ppt');
}

function convertOffice(directory, filename, extension) {
  const profile = path.join(directory, `.lo-${extension}-${filename.replace(/[^A-Za-z0-9]/g, '-')}`);
  fs.mkdirSync(profile, { recursive: true });
  const filter = ({
    docx: 'docx:Office Open XML Text',
    doc: 'doc:MS Word 97',
    xlsx: 'xlsx:Calc MS Excel 2007 XML',
    xls: 'xls:MS Excel 97',
    ppt: 'ppt:MS PowerPoint 97',
  })[extension] || extension;
  const result = spawnSync('libreoffice', [
    '--headless',
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    ...(path.extname(filename).toLowerCase() === '.html' ? ['--infilter=HTML'] : []),
    '--convert-to', filter,
    '--outdir', directory,
    path.join(directory, filename),
  ], { encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`LibreOffice ${filename} -> ${extension} failed: ${result.stderr || result.stdout}`);
  const expected = path.join(directory, `${path.basename(filename, path.extname(filename))}.${extension}`);
  if (!fs.existsSync(expected)) throw new Error(`LibreOffice did not create ${expected}: ${result.stderr || result.stdout}`);
}
