export function createAttachmentController({
  api,
  windowRef,
  documentRef,
  FileReaderCtor,
  state,
  render,
  notify,
  formatBytes,
  normalizeFilePayload,
  messageTextForCopy,
  writeClipboardText,
  allExtensions,
  imageExtensions,
  maxUploadBytes,
  setTimer = setTimeout,
}) {
  const ALL_ATTACHMENT_EXTENSIONS = allExtensions;
  const IMAGE_ATTACHMENT_EXTENSIONS = imageExtensions;
  const MAX_UPLOAD_FILE_BYTES = maxUploadBytes;
  let dragFileDepth = 0;
  let previewRequestId = 0;

  function attachmentAcceptValue() {
    const extensions = imageAttachmentMode() ? IMAGE_ATTACHMENT_EXTENSIONS : ALL_ATTACHMENT_EXTENSIONS;
    return Array.from(extensions).map((ext) => `.${ext}`).join(',');
  }

  function imageAttachmentMode() {
    return (state.homeMode === 'image' || state.composerImageMode) && !state.networkDelegationId;
  }

  function clipboardAttachmentFiles(dataTransfer) {
    const directFiles = Array.from(dataTransfer?.files || []).filter(Boolean);
    const files = directFiles.length
      ? directFiles
      : Array.from(dataTransfer?.items || [])
        .filter((item) => item?.kind === 'file')
        .map((item) => item.getAsFile?.())
        .filter(Boolean);
    return files.map((file, index) => normalizeClipboardFile(file, index));
  }

  function normalizeClipboardFile(file, index = 0) {
    const existingName = String(file?.name || '').trim();
    const existingExt = existingName.split('.').pop()?.toLowerCase() || '';
    if (existingExt && ALL_ATTACHMENT_EXTENSIONS.has(existingExt)) return file;
    const mime = String(file?.type || '').toLowerCase();
    const ext = ({
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    })[mime] || '';
    if (!ext) return file;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const generatedName = `粘贴附件-${timestamp}${index ? `-${index + 1}` : ''}.${ext}`;
    // Keep the original clipboard Blob. Re-wrapping a clipboard-backed File can
    // produce a Blob whose reads never settle in some Electron/Chromium builds.
    try {
      Object.defineProperty(file, 'name', { configurable: true, value: generatedName });
      return file;
    } catch {
      if (typeof windowRef.File !== 'function') return file;
      return new windowRef.File([file], generatedName, {
        type: file.type || mime,
        lastModified: file.lastModified || Date.now(),
      });
    }
  }

  function queueClipboardAttachments(dataTransfer) {
    const files = clipboardAttachmentFiles(dataTransfer);
    if (!files.length) return false;
    setTimer(() => { void queueAttachmentFiles(files, { source: 'paste' }); }, 0);
    return true;
  }

  async function queueAttachmentFiles(fileList, { source = 'picker' } = {}) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) {
      if (source === 'drop') notify('没有读取到可上传的文件，暂不支持拖入文件夹。', 'warning');
      return [];
    }
    if (!state.currentUser) {
      state.currentTab = 'settings';
      notify('请先登录账号再上传附件。', 'warning');
      render();
      return [];
    }
    const skipped = [];
    const queued = [];
    for (const file of files) {
      const name = file.name || 'file';
      const ext = name.split('.').pop()?.toLowerCase() || '';
      if (!ext || !ALL_ATTACHMENT_EXTENSIONS.has(ext)) {
        skipped.push(`${name} 格式暂不支持`);
        continue;
      }
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        skipped.push(`${name} 超过 ${formatBytes(MAX_UPLOAD_FILE_BYTES)}`);
        continue;
      }
      if (imageAttachmentMode() && !IMAGE_ATTACHMENT_EXTENSIONS.has(ext)) {
        skipped.push(`${name} 不是支持的图片`);
        continue;
      }
      const item = {
        id: `att-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        file,
        kind: IMAGE_ATTACHMENT_EXTENSIONS.has(ext) ? 'image' : officeAttachmentKind(ext),
        status: 'queued',
        progress: 0,
      };
      if (item.kind === 'image') item.localPreviewUrl = URL.createObjectURL(file);
      state.attachments.push(item);
      item.uploadPromise = uploadAttachmentItem(item);
      queued.push(item);
    }
    render();
    if (queued.length && source !== 'favorite-emoji') {
      notify(`已添加 ${queued.length} 个附件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}。`, skipped.length ? 'warning' : 'success', 3600, 'chat-bottom-right');
      focusActiveComposerInput();
    } else if (queued.length && source === 'favorite-emoji') {
      focusActiveComposerInput();
    } else if (skipped.length) {
      notify(summarizeSkippedFiles(skipped), 'warning');
    }
    return queued;
  }

  function focusActiveComposerInput() {
    setTimer(() => {
      const input = documentRef.getElementById('network-delegation-comment-input')
        || documentRef.getElementById('chat-input');
      if (!input) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange?.(end, end);
    }, 0);
  }

  function summarizeSkippedFiles(skipped = []) {
    if (skipped.length <= 3) return skipped.join('；');
    return `${skipped.slice(0, 3).join('；')}；另有 ${skipped.length - 3} 个文件未添加`;
  }

  function installFileDropHandlers() {
    windowRef.addEventListener('dragenter', (event) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      dragFileDepth += 1;
      setFileDragActive(true);
    });
    windowRef.addEventListener('dragover', (event) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setFileDragActive(true);
    });
    windowRef.addEventListener('dragleave', (event) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      dragFileDepth = Math.max(0, dragFileDepth - 1);
      if (dragFileDepth === 0) setFileDragActive(false);
    });
    windowRef.addEventListener('drop', async (event) => {
      if (!dragEventHasFiles(event)) return;
      event.preventDefault();
      resetFileDragState();
      await queueAttachmentFiles(event.dataTransfer?.files || [], { source: 'drop' });
    });
    windowRef.addEventListener('dragend', resetFileDragState);
    windowRef.addEventListener('blur', resetFileDragState);
  }

  function dragEventHasFiles(event) {
    const types = Array.from(event.dataTransfer?.types || []);
    const items = Array.from(event.dataTransfer?.items || []);
    return types.includes('Files') || items.some((item) => item.kind === 'file') || Boolean(event.dataTransfer?.files?.length);
  }

  function setFileDragActive(active) {
    if (state.draggingFiles === active) return;
    state.draggingFiles = active;
    render();
  }

  function resetFileDragState() {
    dragFileDepth = 0;
    setFileDragActive(false);
  }

  async function uploadAttachmentItem(item) {
    try {
      item.status = 'uploading';
      item.progress = 5;
      render();
      let sourcePath = '';
      try {
        sourcePath = api.pathForFile?.(item.file) || '';
      } catch {
        sourcePath = '';
      }
      if (sourcePath && api.uploadFilePath) {
        item.progress = 35;
        render();
        item.uploaded = await api.uploadFilePath({
          sourcePath,
          filename: item.file.name,
          contentType: item.file.type || '',
        });
      } else {
        if (Number(item.file?.size || 0) > 60 * 1024 * 1024) {
          throw new Error('当前环境无法安全读取 60 MB 以上的浏览器文件，请使用桌面端文件选择器。');
        }
        const dataBase64 = await fileToBase64(item.file);
        item.progress = 70;
        render();
        item.uploaded = await api.uploadFile({
          filename: item.file.name,
          contentType: item.file.type || '',
          dataBase64,
        });
      }
      item.status = 'done';
      item.progress = 100;
      render();
      return item.uploaded;
    } catch (error) {
      item.status = 'error';
      item.error = error.message || String(error);
      render();
      notify(`${item.file?.name || '附件'} 导入失败：${item.error}`, 'error');
      return null;
    }
  }

  async function fileToBase64(file) {
    if (typeof file?.arrayBuffer === 'function' && typeof windowRef?.btoa === 'function') {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Keep chunks divisible by three so independently encoded Base64
        // segments can be concatenated without padding corrupting the payload.
        const chunkSize = 0x6000;
        let encoded = '';
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          const binary = String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
          encoded += windowRef.btoa(binary);
        }
        const contentType = String(file.type || 'application/octet-stream');
        return `data:${contentType};base64,${encoded}`;
      } catch {
        // Some older WebKit/Electron clipboard File implementations expose an
        // unusable arrayBuffer(). Keep FileReader as the cross-version fallback.
      }
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReaderCtor();
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
  }

  async function readyAttachmentsForSend(attachmentItems = state.attachments) {
    if (!attachmentItems.length) return [];
    const pending = attachmentItems.filter((item) => item.uploadPromise && item.status !== 'done' && item.status !== 'error');
    if (pending.length) await Promise.all(pending.map((item) => item.uploadPromise));
    const failed = attachmentItems.find((item) => item.status === 'error');
    if (failed) throw new Error(`${failed.file?.name || failed.name || '附件'} ${failed.error || '上传失败'}`);
    return attachmentItems.filter((item) => item.uploaded).map(attachmentItemToMessagePayload);
  }

  function pendingAttachmentsForMessage(attachmentItems = state.attachments) {
    if (!attachmentItems.length) return [];
    return attachmentItems.map(attachmentItemToMessagePayload);
  }

  function attachmentItemToMessagePayload(item = {}) {
    const uploaded = item.uploaded || {};
    const file = item.file || {};
    const name = uploaded.filename || file.name || item.name || 'file';
    const favoriteEmoji = item.source === 'favorite-emoji' || uploaded.favorite_emoji === true;
    return {
      id: uploaded.id || item.id || '',
      name,
      filename: name,
      type: file.type || uploaded.content_type || item.type || '',
      content_type: file.type || uploaded.content_type || item.content_type || '',
      size: uploaded.size || file.size || item.size || 0,
      path: uploaded.path || file.path || item.path || '',
      relative_path: uploaded.relative_path || item.relative_path || '',
      file_url: uploaded.file_url || uploaded.preview_url || uploaded.download_url || item.localPreviewUrl || '',
      preview_url: uploaded.preview_url || uploaded.file_url || uploaded.download_url || item.localPreviewUrl || '',
      download_url: uploaded.download_url || uploaded.file_url || uploaded.preview_url || '',
      render_url: uploaded.render_url || '',
      // Favorite stickers already have a stable data URL in the composer.
      // Keep it on the message payload so the chat renderer can reuse the
      // exact same asset as the favorites grid instead of re-decoding a
      // remote preview with different dimensions/metadata.
      ...(favoriteEmoji && (uploaded.value || uploaded.url || item.value || item.url) ? {
        value: uploaded.value || uploaded.url || item.value || item.url,
        url: uploaded.url || uploaded.value || item.url || item.value,
      } : {}),
      kind: item.kind || uploaded.kind || '',
      remote_file_id: uploaded.remote_file_id || uploaded.remoteFileId || '',
      remote_file_kind: uploaded.remote_file_kind || uploaded.remoteFileKind || '',
      group_id: uploaded.group_id || uploaded.groupId || '',
      sha256: uploaded.sha256 || '',
      favorite_emoji: favoriteEmoji,
    };
  }


  function officeAttachmentKind(ext = '') {
    if (['doc', 'docx'].includes(ext)) return ext;
    if (['xls', 'xlsx'].includes(ext)) return ext;
    if (['ppt', 'pptx'].includes(ext)) return ext;
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'archive';
    if (['exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso'].includes(ext)) return 'installer';
    return 'file';
  }

  function updateLocalMessageAttachments(messageId, attachments = []) {
    if (!messageId || !attachments.length) return;
    const message = state.messages.find((item) => item.id === messageId);
    if (!message) return;
    message.metadata = {
      ...(message.metadata || {}),
      attachments,
    };
  }

  async function previewAttachment(attachmentId) {
    const item = state.attachments.find((entry) => entry.id === attachmentId);
    if (!item) return;
    if (item.uploadPromise && item.status !== 'done' && item.status !== 'error') await item.uploadPromise;
    if (!item.uploaded) {
      notify(item.error || '附件尚未上传完成。', item.status === 'error' ? 'error' : 'warning');
      return;
    }
    await previewFileInfo({
      id: item.uploaded.id,
      filename: item.uploaded.filename || item.file.name,
      path: item.uploaded.path,
      name: item.uploaded.filename || item.file.name,
      fileUrl: item.uploaded.file_url || item.uploaded.preview_url,
      size: item.uploaded.size || item.file.size,
    });
  }

  async function previewFileInfo(file) {
    if (!file) return;
    const requestId = ++previewRequestId;
    const requestedSource = normalizeFilePayload(file);
    if (!requestedSource.path && requestedSource.remote_file_id) {
      state.preview = previewLoadingState(requestedSource, requestId);
      render();
    }
    try {
      file = await materializeCollaborationFile(file);
    } catch (error) {
      if (state.preview?.preview_request_id === requestId) {
        state.preview = null;
        render();
      }
      notifyAttachmentActionError('下载附件失败', error);
      return;
    }
    const sourceFile = normalizeFilePayload(file);
    const filename = sourceFile.name || sourceFile.filename || '';
    const isPptx = sourceFile.kind === 'pptx' || /\.pptx?$/i.test(filename);
    const isOfficePdfBacked = ['doc', 'docx', 'xls', 'xlsx'].includes(sourceFile.kind) || /\.(?:docx?|xlsx?)$/i.test(filename);
    const directPreviewUrl = file.fileUrl || file.file_url || file.preview_url || file.previewUrl || file.download_url || file.downloadUrl || file.url || '';
    if (directPreviewUrl) {
      const ext = (file.name || file.filename || '').split('.').pop()?.toLowerCase() || '';
      if (IMAGE_ATTACHMENT_EXTENSIONS.has(ext) || file.kind === 'image') {
        state.preview = {
          ...sourceFile,
          kind: 'image',
          name: file.name || file.filename || 'image',
          path: file.path || '',
          fileUrl: directPreviewUrl,
          size: file.size || 0,
          action_file: sourceFile,
        };
        render();
        return;
      }
    }
    state.preview = previewLoadingState(sourceFile, requestId);
    render();
    try {
      const result = await api.renderFile(withCurrentFileAccessContext({
        id: file.id || '',
        filename: file.filename || file.name || '',
        path: file.path || '',
        relative_path: file.relative_path || file.relativePath || '',
        messageId: sourceFile.messageId || '',
      }));
      if (state.preview?.preview_request_id !== requestId) return;
      state.preview = result;
      state.preview.path = state.preview.path || file.path || '';
      state.preview.sha256 = sourceFile.sha256 || state.preview.sha256 || '';
      state.preview.messageId = sourceFile.messageId || '';
      state.preview.sessionId = sourceFile.sessionId || '';
      state.preview.projectId = sourceFile.projectId || '';
      if (isPptx || isOfficePdfBacked) {
        state.preview = {
          ...state.preview,
          name: sourceFile.name,
          filename: sourceFile.filename,
          size: sourceFile.size || state.preview.size || 0,
          office_pdf_url: sourceFile.office_pdf_url || state.preview.office_pdf_url || '',
          preview_render_mode: sourceFile.preview_render_mode || state.preview.preview_render_mode || '',
          cover_url: sourceFile.cover_url || state.preview.cover_url || '',
          slide_image_urls: sourceFile.slide_image_urls || [],
          action_file: sourceFile,
        };
      }
      render();
    } catch (error) {
      if (state.preview?.preview_request_id !== requestId) return;
      if (isPptx && (sourceFile.cover_url || sourceFile.office_pdf_url)) {
        state.preview = {
          ...sourceFile,
          kind: 'pptx',
          slides: [],
          action_file: sourceFile,
        };
        render();
        return;
      }
      state.preview = null;
      render();
      notify(`预览失败：${error.message || error}`, 'error');
    }
  }

  function previewLoadingState(file = {}, requestId = 0) {
    const filename = file.name || file.filename || '';
    return {
      ...file,
      kind: file.kind || officeAttachmentKind(filename.split('.').pop()?.toLowerCase() || ''),
      name: filename || '文件预览',
      preview_loading: true,
      preview_request_id: requestId,
      action_file: file,
    };
  }

  async function saveFileFromPayload(file) {
    try {
      file = await materializeCollaborationFile(file);
      if (!file?.path && !file?.relative_path && !file?.relativePath) return notify('这个文件暂时没有可保存的本地路径。', 'warning');
      const result = await api.saveFileCopy(withCurrentFileAccessContext(file));
      if (!result?.canceled) notify(`已保存：${result.path}`, 'success');
    } catch (error) {
      notifyAttachmentActionError('保存失败', error);
    }
  }

  async function showFileFromPayload(file) {
    try {
      file = await materializeCollaborationFile(file);
      if (!file?.path && !file?.relative_path && !file?.relativePath) return notify('这个文件暂时没有可定位的本地路径。', 'warning');
      await api.showFileInFolder(withCurrentFileAccessContext(file));
    } catch (error) {
      notifyAttachmentActionError('定位失败', error);
    }
  }

  async function openFileFromPayload(file) {
    try {
      file = await materializeCollaborationFile(file);
      if (!file?.path && !file?.relative_path && !file?.relativePath) return notify('这个文件暂时没有可打开的本地路径。', 'warning');
      if (!api.openFile) {
        if (isPreviewableImageFile(file)) return previewFileInfo(file);
        return notify('当前版本暂不支持直接打开文件。', 'warning');
      }
      const extension = fileExtension(file);
      if (['exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso'].includes(extension)
        && !windowRef.confirm('该文件可能包含可执行内容，打开后可能修改系统。确认继续吗？')) return;
      const result = await api.openFile(withCurrentFileAccessContext(file));
      if (result) {
        if (isPreviewableImageFile(file)) return previewFileInfo(file);
        notify(`打开失败：${result}`, 'error');
      }
    } catch (error) {
      if (isPreviewableImageFile(file)) {
        try {
          await previewFileInfo(file);
          return;
        } catch {}
      }
      notifyAttachmentActionError('打开失败', error);
    }
  }

  function fileExtension(file = {}) {
    return String(file.name || file.filename || file.path || '').split('.').pop()?.toLowerCase() || '';
  }

  function isPreviewableImageFile(file = {}) {
    const extension = fileExtension(file);
    const contentType = String(file.content_type || file.type || '').toLowerCase();
    return IMAGE_ATTACHMENT_EXTENSIONS.has(extension) || contentType.startsWith('image/');
  }

  async function copyFilePath(filePath = '') {
    const value = String(filePath || '').trim();
    if (!value) return notify('这个文件暂时没有可复制的路径。', 'warning');
    try {
      await writeClipboardText(value);
      notify('已复制文件路径。', 'success');
    } catch (error) {
      notify(`复制路径失败：${error.message || error}`, 'error');
    }
  }

  async function copyImageFromPayload(file) {
    try {
      file = await materializeCollaborationFile(file);
      if (!file || (!isPreviewableImageFile(file) && file.kind !== 'image')) {
        return notify('所选文件不是可复制的图片。', 'warning');
      }
      if (!api.writeClipboardImage) return notify('当前版本暂不支持复制图片。', 'warning');
      await api.writeClipboardImage(withCurrentFileAccessContext(file));
      notify('图片已复制。', 'success');
    } catch (error) {
      notifyAttachmentActionError('复制图片失败', error);
    }
  }

  async function materializeCollaborationFile(file = {}) {
    const normalized = normalizeFilePayload(file);
    if (normalized.path || !normalized.remote_file_id) return normalized;
    if (!api.downloadCollaborationFile) throw new Error('当前客户端不支持附件下载。');
    const downloaded = await api.downloadCollaborationFile({
      fileId: normalized.remote_file_id,
      name: normalized.name,
      filename: normalized.filename,
      contentType: normalized.content_type,
      type: normalized.type,
      size: normalized.size,
      sha256: normalized.sha256,
      remoteFileKind: normalized.remote_file_kind,
      groupId: normalized.group_id || state.collaborationGroupId || '',
    });
    if (downloaded?.unavailable) {
      const error = new Error(downloaded.message || '附件当前不可用。');
      error.code = downloaded.code || 'collaboration_file_unavailable';
      error.reason = downloaded.reason || '';
      throw error;
    }
    return normalizeFilePayload({ ...normalized, ...(downloaded || {}), remote_file_id: normalized.remote_file_id, sha256: normalized.sha256 });
  }

  function notifyAttachmentActionError(prefix, error) {
    const code = String(error?.code || '');
    const expectedUnavailable = code.startsWith('collaboration_file_');
    notify(expectedUnavailable ? String(error?.message || error) : `${prefix}：${error?.message || error}`,
      expectedUnavailable ? 'warning' : 'error');
  }

  function withCurrentFileAccessContext(file = {}) {
    const session = (state.sessions || []).find((item) => item.id === state.currentSessionId) || null;
    return {
      ...file,
      sessionId: session?.id || state.currentSessionId || '',
      projectId: session?.projectId || session?.project_id || state.activeProjectId || '',
    };
  }

  async function copyMessageText(messageId) {
    const message = [
      state.messages,
      state.networkConversationMessages,
      state.chatGroupDetail?.messages,
      state.collaborationGroupDetail?.messages,
    ].flatMap((items) => Array.isArray(items) ? items : []).find((item) => item.id === messageId);
    const text = messageTextForCopy(message);
    if (!text) return notify('这条消息没有可复制的文本。', 'warning');
    try {
      await writeClipboardText(text);
      notify('已复制内容。', 'success');
    } catch (error) {
      notify(`复制失败：${error.message || error}`, 'error');
    }
  }

  async function attachContextFiles() {
    if (!state.currentUser) {
      state.currentTab = 'settings';
      notify('请先登录账号再上传附件。', 'warning');
      render();
      return;
    }
    if (api.selectFiles) {
      try {
        const result = await api.selectFiles({
          extensions: Array.from(imageAttachmentMode() ? IMAGE_ATTACHMENT_EXTENSIONS : ALL_ATTACHMENT_EXTENSIONS),
        });
        if (!result?.canceled) queueUploadedAttachments(result?.files || [], { source: 'picker' });
        if (result?.errors?.length) notify(summarizeSkippedFiles(result.errors), result?.files?.length ? 'warning' : 'error');
      } catch (error) {
        notify(`选择文件失败：${error.message || error}`, 'error');
      }
      return;
    }
    const input = documentRef.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.tabIndex = -1;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.top = '0';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.accept = attachmentAcceptValue();
    input.addEventListener('change', async () => {
      try {
        await queueAttachmentFiles(input.files || [], { source: 'picker' });
      } finally {
        input.remove();
      }
    }, { once: true });
    documentRef.body.appendChild(input);
    input.click();
  }

  function queueUploadedAttachments(files = [], { source = 'picker' } = {}) {
    const uploadedFiles = Array.from(files || []).filter(Boolean);
    if (!uploadedFiles.length) {
      if (source !== 'picker') notify('没有读取到可上传的文件。', 'warning');
      return [];
    }
    const skipped = [];
    const queued = [];
    for (const uploaded of uploadedFiles) {
      const name = uploaded.name || uploaded.filename || 'file';
      const ext = name.split('.').pop()?.toLowerCase() || '';
      if (!ext || !ALL_ATTACHMENT_EXTENSIONS.has(ext)) {
        skipped.push(`${name} 格式暂不支持`);
        continue;
      }
      if (Number(uploaded.size || 0) > MAX_UPLOAD_FILE_BYTES) {
        skipped.push(`${name} 超过 ${formatBytes(MAX_UPLOAD_FILE_BYTES)}`);
        continue;
      }
      if (imageAttachmentMode() && !IMAGE_ATTACHMENT_EXTENSIONS.has(ext)) {
        skipped.push(`${name} 不是支持的图片`);
        continue;
      }
      const item = {
        id: `att-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        kind: IMAGE_ATTACHMENT_EXTENSIONS.has(ext) ? 'image' : officeAttachmentKind(ext),
        status: 'done',
        progress: 100,
        uploaded,
        source,
      };
      state.attachments.push(item);
      queued.push(item);
    }
    render();
    if (queued.length && source !== 'favorite-emoji') {
      notify(`已添加 ${queued.length} 个附件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}。`, skipped.length ? 'warning' : 'success', 3600, 'chat-bottom-right');
      focusActiveComposerInput();
    } else if (skipped.length) {
      notify(summarizeSkippedFiles(skipped), 'warning');
    }
    return queued;
  }

  function retryAttachment(attachmentId) {
    const item = state.attachments.find((entry) => entry.id === attachmentId);
    if (!item || item.status !== 'error' || !item.file) return;
    item.error = '';
    item.progress = 0;
    item.uploadPromise = uploadAttachmentItem(item);
    render();
  }

  return {
    attachContextFiles,
    attachmentAcceptValue,
    attachmentItemToMessagePayload,
    copyFilePath,
    copyImageFromPayload,
    copyMessageText,
    focusActiveComposerInput,
    imageAttachmentMode,
    installFileDropHandlers,
    materializeCollaborationFile,
    openFileFromPayload,
    pendingAttachmentsForMessage,
    previewAttachment,
    previewFileInfo,
    queueClipboardAttachments,
    queueAttachmentFiles,
    queueUploadedAttachments,
    readyAttachmentsForSend,
    retryAttachment,
    saveFileFromPayload,
    showFileFromPayload,
    updateLocalMessageAttachments,
  };
}
