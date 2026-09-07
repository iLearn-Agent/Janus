import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderUploadedFileOffMainThread } from '../src/main/filePreviewWorkerClient.js';
import { renderPreviewBody } from '../src/renderer/app/components/overlays.js';
import { createAttachmentController } from '../src/renderer/app/features/chat/attachmentController.js';
import { normalizeFilePayload } from '../src/renderer/app/utils/filePayload.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-file-preview-async-'));
const file = path.join(root, 'preview.md');
const previousDelay = process.env.JANUS_FILE_PREVIEW_WORKER_DELAY_MS;
fs.writeFileSync(file, '# Async preview\n\nThe main thread remains responsive.\n');

try {
  process.env.JANUS_FILE_PREVIEW_WORKER_DELAY_MS = '300';
  let timerFired = false;
  let previewSettled = false;
  setTimeout(() => { timerFired = true; }, 30);
  const previewPromise = renderUploadedFileOffMainThread(root, { path: file }, { allowedRoots: [root] })
    .finally(() => { previewSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(timerFired, true, 'main-thread timers must run while preview work is active');
  assert.equal(previewSettled, false, 'the delayed worker fixture must still be rendering');
  const workerPreview = await previewPromise;
  assert.equal(workerPreview.kind, 'markdown');
  assert.match(workerPreview.text, /main thread remains responsive/);

  const pending = [];
  const state = {
    attachments: [], sessions: [{ id: 'session-1', projectId: 'project-1' }],
    currentSessionId: 'session-1', activeProjectId: 'project-1', preview: null,
  };
  const controller = createAttachmentController({
    api: { renderFile: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) },
    windowRef: {}, documentRef: {}, FileReaderCtor: class {}, state,
    render: () => {}, notify: () => {}, formatBytes: String, normalizeFilePayload,
    messageTextForCopy: () => '', writeClipboardText: async () => {},
    allExtensions: new Set(['docx']), imageExtensions: new Set(), maxUploadBytes: 1024,
  });

  const firstOpen = controller.previewFileInfo({ name: 'report.docx', path: '/tmp/report.docx', kind: 'docx' });
  await waitFor(() => pending.length === 1);
  assert.equal(state.preview.preview_loading, true);
  assert.match(renderPreviewBody(state.preview), /正在准备文件预览/);
  pending.shift().resolve({ name: 'report.docx', kind: 'docx', blocks: [{ type: 'paragraph', text: 'ready' }] });
  await firstOpen;
  assert.equal(state.preview.preview_loading, undefined);
  assert.equal(state.preview.blocks[0].text, 'ready');

  const closedOpen = controller.previewFileInfo({ name: 'closed.docx', path: '/tmp/closed.docx', kind: 'docx' });
  await waitFor(() => pending.length === 1);
  assert.equal(state.preview.preview_loading, true);
  state.preview = null;
  pending.shift().resolve({ name: 'closed.docx', kind: 'docx', blocks: [{ type: 'paragraph', text: 'must not reopen' }] });
  await closedOpen;
  assert.equal(state.preview, null, 'a completed background preview must not reopen a modal the user closed');

  let resolveDownload;
  const remoteState = {
    attachments: [], sessions: [{ id: 'session-1', projectId: 'project-1' }],
    currentSessionId: 'session-1', activeProjectId: 'project-1', preview: null,
  };
  const remoteController = createAttachmentController({
    api: {
      downloadCollaborationFile: () => new Promise((resolve) => { resolveDownload = resolve; }),
      renderFile: async () => ({ name: 'remote.pdf', kind: 'pdf', fileUrl: 'file:///tmp/remote.pdf' }),
    },
    windowRef: {}, documentRef: {}, FileReaderCtor: class {}, state: remoteState,
    render: () => {}, notify: () => {}, formatBytes: String, normalizeFilePayload,
    messageTextForCopy: () => '', writeClipboardText: async () => {},
    allExtensions: new Set(['pdf']), imageExtensions: new Set(), maxUploadBytes: 1024,
  });
  const remoteOpen = remoteController.previewFileInfo({
    name: 'remote.pdf', kind: 'pdf', remote_file_id: 'remote-file-1', remote_file_kind: 'social',
  });
  await waitFor(() => typeof resolveDownload === 'function');
  assert.equal(remoteState.preview.preview_loading, true, 'remote downloads must show preview feedback immediately');
  resolveDownload({ path: '/tmp/remote.pdf', name: 'remote.pdf', kind: 'pdf' });
  await remoteOpen;
  assert.equal(remoteState.preview.kind, 'pdf');

  process.env.JANUS_FILE_PREVIEW_WORKER_DELAY_MS = '20';
  const formatFiles = new Map([
    ['sample.csv', 'a,b\n1,2\n'],
    ['sample.pdf', '%PDF-1.4\n%%EOF\n'],
    ['sample.docx', 'not a real docx'],
    ['sample.xlsx', 'not a real xlsx'],
    ['sample.pptx', 'not a real pptx'],
    ['sample.png', 'not a real png'],
    ['sample.zip', 'safe archive metadata'],
    ['sample.exe', 'safe installer metadata'],
  ]);
  const expectedKinds = ['text', 'pdf', 'docx', 'xlsx', 'pptx', 'image', 'archive', 'installer'];
  const matrixResults = [];
  for (const [name, content] of formatFiles) {
    const target = path.join(root, name);
    fs.writeFileSync(target, content);
    matrixResults.push(await renderUploadedFileOffMainThread(root, { path: target }, { allowedRoots: [root] }));
  }
  assert.deepEqual(matrixResults.map((item) => item.kind), expectedKinds);
  for (const preview of matrixResults) assert.ok(renderPreviewBody(preview), `${preview.kind} preview must render`);
  assert.match(renderPreviewBody(matrixResults[5]), /decoding="async"/);

  console.log('File preview async worker and loading-state smoke passed.');
} finally {
  if (previousDelay === undefined) delete process.env.JANUS_FILE_PREVIEW_WORKER_DELAY_MS;
  else process.env.JANUS_FILE_PREVIEW_WORKER_DELAY_MS = previousDelay;
  fs.rmSync(root, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for preview state.');
}
