import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { writeImageFileToClipboard } from '../src/main/ipc/registerIpcHandlers.js';
import { renderPreviewModal } from '../src/renderer/app/components/overlays.js';
import { createAttachmentController } from '../src/renderer/app/features/chat/attachmentController.js';
import { state as rendererState } from '../src/renderer/app/state.js';
import { normalizeFilePayload } from '../src/renderer/app/utils/filePayload.js';
import { renderMessageAttachmentCards } from '../src/renderer/app/views/chatView.js';

const clipboardImages = [];
const nativeImagePaths = [];
const fakeImage = { isEmpty: () => false, getSize: () => ({ width: 32, height: 24 }) };
assert.deepEqual(writeImageFileToClipboard({
  clipboard: { writeImage: (image) => clipboardImages.push(image) },
  nativeImage: { createFromPath: (filePath) => { nativeImagePaths.push(filePath); return fakeImage; } },
  file: { kind: 'image', content_type: 'image/png', path: '/tmp/janus-image-copy.png' },
}), { ok: true, size: { width: 32, height: 24 } });
assert.deepEqual(nativeImagePaths, ['/tmp/janus-image-copy.png']);
assert.deepEqual(clipboardImages, [fakeImage]);
assert.throws(() => writeImageFileToClipboard({
  clipboard: { writeImage() {} },
  nativeImage: { createFromPath: () => fakeImage },
  file: { kind: 'text', content_type: 'text/plain', path: '/tmp/not-an-image.txt' },
}), /不是可复制的图片/);
assert.throws(() => writeImageFileToClipboard({
  clipboard: { writeImage() {} },
  nativeImage: { createFromPath: () => fakeImage },
  file: { kind: 'image', content_type: 'image/png', path: '/tmp/huge.png', size: 81 * 1024 * 1024 },
}), /图片过大/);

const imageFile = {
  id: 'uploaded-image-id',
  kind: 'image',
  name: '上传图片.png',
  filename: '上传图片.png',
  path: '/tmp/uploaded-image.png',
  content_type: 'image/png',
  file_url: 'file:///tmp/uploaded-image.png',
};
const cardMarkup = renderMessageAttachmentCards([imageFile]);
assert.match(cardMarkup, /data-image-context-file=/);
assert.match(cardMarkup, /data-preview-file=/);

const previousPreview = rendererState.preview;
rendererState.preview = { ...imageFile, fileUrl: imageFile.file_url, action_file: imageFile };
const previewMarkup = renderPreviewModal();
assert.match(previewMarkup, /data-copy-image=/);
assert.match(previewMarkup, /title="复制图片"/);
assert.match(previewMarkup, /class="preview-image"[^>]*data-image-context-file=/);
rendererState.preview = previousPreview;

const clipboardPayloads = [];
const notices = [];
const controllerState = {
  sessions: [{ id: 'image-session', projectId: 'image-project' }],
  currentSessionId: 'image-session',
  activeProjectId: 'image-project',
  collaborationGroupId: '',
};
const controller = createAttachmentController({
  api: { writeClipboardImage: async (payload) => clipboardPayloads.push(payload) },
  windowRef: {},
  documentRef: {},
  FileReaderCtor: class {},
  state: controllerState,
  render() {},
  notify: (message, tone) => notices.push({ message, tone }),
  formatBytes: (value) => String(value),
  normalizeFilePayload,
  messageTextForCopy: () => '',
  writeClipboardText: async () => {},
  allExtensions: new Set(['png']),
  imageExtensions: new Set(['png']),
  maxUploadBytes: 1024,
});
await controller.copyImageFromPayload(imageFile);
assert.equal(clipboardPayloads.length, 1);
assert.equal(clipboardPayloads[0].path, imageFile.path);
assert.equal(clipboardPayloads[0].sessionId, 'image-session');
assert.equal(clipboardPayloads[0].projectId, 'image-project');
assert.deepEqual(notices.at(-1), { message: '图片已复制。', tone: 'success' });

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8');
assert.match(rendererSource, /data-message-context-action="copy-image"/);
assert.match(rendererSource, /data-message-context-action="preview-image"/);
assert.match(rendererSource, /data-message-context-action="save-image"/);
assert.match(rendererSource, /event\.stopPropagation\(\);[\s\S]*openImageMenu/);
assert.match(rendererSource, /bindGlobalFileAction\('\[data-copy-image\]'/);
assert.match(preloadSource, /writeClipboardImage: \(payload = \{\}\) => ipcRenderer\.invoke\('clipboard:write-image', payload\)/);

console.log('image clipboard actions smoke passed');
