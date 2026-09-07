import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderCodexTranscript } from '../src/renderer/app/views/codexTranscriptView.js';
import { renderCodexChangeSummary } from '../src/renderer/app/views/codexChangeReviewView.js';
import {
  cleanupStaleCodexReviewPortal,
  codexReviewPortalSourceMounted,
  mountCodexReviewPortal,
  updateCodexHoverPreviewPlacement,
} from '../src/renderer/app/features/chat/chatRunController.js';
import { renderMarkdown } from '../src/renderer/app/utils/format.js';

const { app, BrowserWindow } = globalThis.__janusElectron || {};
assert.ok(app && BrowserWindow, 'Electron runtime is unavailable.');

const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-codex-diff-smoke-'));
const htmlPath = path.join(tempRoot, 'index.html');
let browserWindow = null;

try {
  await app.whenReady();
  const longDiff = ['@@ -0,0 +1,245 @@', ...Array.from({ length: 245 }, (_, index) => `+line ${index + 1}`)].join('\n');
  const events = [
    {
      activityId: 'native-reasoning', activityType: 'reasoning', eventOrigin: 'codex', status: 'completed',
      detail: '我会先确认修改范围，再逐项检查文件结果。',
    },
    {
      activityId: 'native-approval', activityType: 'approval', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'waiting',
      title: '文件修改等待批准', approvalType: 'file',
      changes: [{ path: '/home/private/Janus-main/docs/pending.docx', kind: 'update', comparison: {
        version: 1, status: 'pending', strict: false, baselineCaptured: true,
        reason: 'waiting_for_completed_file_state', nativeChangeSource: 'codex_app_server', derivedSource: 'janus_turn_snapshot',
      } }],
    },
    {
      activityId: 'native-css', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      changes: [{
        path: '/home/private/Janus-main/src/renderer/styles/demo.css', kind: 'update',
        diff: '--- a/src/renderer/styles/demo.css\n+++ b/src/renderer/styles/demo.css\n@@ -1 +1 @@\n-old\n+new',
      }],
    },
    {
      activityId: 'native-binary', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      changes: [{
        path: '/home/private/Janus-main/assets/demo.png', kind: 'update',
        diff: 'Binary files a/assets/demo.png and b/assets/demo.png differ',
        comparison: {
          version: 1, status: 'complete', strict: true, kind: 'image',
          before: { sha256: '1111111111111111', sizeBytes: 1024 }, after: { sha256: '2222222222222222', sizeBytes: 2048 },
          semantic: { beforeMetrics: { width: 640, height: 360, bytes: 1024 }, afterMetrics: { width: 1280, height: 720, bytes: 2048 }, added: [], removed: [], truncated: false },
          nativeChangeSource: 'codex_app_server', derivedSource: 'janus_turn_snapshot',
        },
      }],
    },
    {
      activityId: 'native-document', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      changes: [{
        path: '/home/private/Janus-main/docs/specification.docx', kind: 'update',
        diff: 'Binary files a/docs/specification.docx and b/docs/specification.docx differ',
        comparison: {
          version: 1, status: 'complete', strict: true, kind: 'docx',
          before: { sha256: 'aaaaaaaaaaaaaaaa', snapshot: { path: '/home/private/runtime/before.docx', name: 'specification-before.docx' } },
          after: { sha256: 'bbbbbbbbbbbbbbbb', snapshot: { path: '/home/private/runtime/after.docx', name: 'specification-after.docx' } },
          semantic: {
            beforeMetrics: { headings: 1, paragraphs: 2, lists: 0, tables: 1 },
            afterMetrics: { headings: 2, paragraphs: 3, lists: 1, tables: 1 },
            removed: [{ type: 'heading', label: '标题 1', text: '旧标题' }],
            added: [{ type: 'heading', label: '标题 1', text: '新标题' }],
            truncated: false,
          },
          nativeChangeSource: 'codex_app_server', derivedSource: 'janus_turn_snapshot',
        },
      }],
    },
    {
      activityId: 'native-long', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      changes: [{ path: '/home/private/Janus-main/src/generated.js', kind: 'add', diff: longDiff }],
    },
    {
      activityId: 'native-turn-diff', activityType: 'file', eventOrigin: 'codex', nativeSource: 'codex_app_server', status: 'completed',
      diff: '@@ -1 +1 @@\n-old\n+new',
    },
  ];
  const transcript = renderCodexTranscript(events, { messageId: 'codex-diff-smoke' });
  const changeSummary = renderCodexChangeSummary(events, { messageId: 'codex-diff-smoke' });
  const styles = readFileSync(path.join(root, 'src/renderer/styles/chat.css'), 'utf8');
  const quote = renderMarkdown('> 这是一段引用内容\n> 第二行仍属于引用');
  writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8"><style>${styles}</style><div class="app-frame theme-dark"><main class="chat-view with-messages" style="width:920px"><div id="message-list" style="position:relative;height:520px;overflow:auto"><article data-message-id="codex-diff-smoke">${transcript}${quote}${changeSummary}</article></div></main></div>`);

  browserWindow = new BrowserWindow({ show: false, width: 1100, height: 900 });
  await browserWindow.loadFile(htmlPath);
  const placementSource = updateCodexHoverPreviewPlacement.toString();
  const mountPortalSource = mountCodexReviewPortal.toString();
  const portalSourceMountedSource = codexReviewPortalSourceMounted.toString();
  const cleanupPortalSource = cleanupStaleCodexReviewPortal.toString();
  const browserScript = `(() => { try {
    const approval = document.querySelector('[data-codex-operation-toggle="codex-diff-smoke::native-approval"]');
    const reasoningBatch = document.querySelector('.codex-reasoning-actions');
    const operation = document.querySelector('[data-codex-operation-toggle="codex-diff-smoke::native-css"]');
    operation.open = true;
    operation.querySelectorAll('.codex-file-change').forEach((item) => { if (item.tagName === 'DETAILS') item.open = true; });
    const cards = Array.from(operation.querySelectorAll('.codex-file-change'));
    const pathText = (card) => card.querySelector('summary .codex-file-path-button, summary code')?.textContent || '';
    const cssCard = cards.find((card) => pathText(card).includes('demo.css'));
    const binaryCard = cards.find((card) => pathText(card).includes('demo.png'));
    const documentCard = cards.find((card) => pathText(card).includes('specification.docx'));
    const longCard = cards.find((card) => pathText(card).includes('generated.js'));
    const added = cssCard?.querySelector('.codex-diff-line.is-add');
    const deleted = cssCard?.querySelector('.codex-diff-line.is-delete');
    const addedNumbers = Array.from(added?.querySelectorAll('.codex-diff-line-number') || []).map((node) => node.textContent.trim());
    const deletedNumbers = Array.from(deleted?.querySelectorAll('.codex-diff-line-number') || []).map((node) => node.textContent.trim());
    const changeCard = document.querySelector('.codex-change-summary');
    const reviewTemplate = document.querySelector('[data-codex-review-template]');
    const changeDialog = reviewTemplate?.content?.querySelector('[data-codex-review-dialog]')?.cloneNode(true) || null;
    if (changeDialog) {
      changeDialog.dataset.codexReviewPortaled = 'true';
      changeDialog.classList.add('theme-dark');
      changeDialog.setAttribute('open', '');
      document.body.append(changeDialog);
    }
    const hoverPreview = changeCard?.querySelector('.codex-change-hover-preview');
    const hoverRow = changeCard?.querySelector('.codex-change-summary-row');
    hoverRow?.classList.add('is-preview-open');
    const messageList = document.getElementById('message-list');
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
    const hoverPlacement = (${placementSource})(hoverRow, { windowRef: window });
    const hoverDisplay = hoverPreview ? getComputedStyle(hoverPreview).display : '';
    const hoverDiff = hoverPreview?.querySelector('.codex-change-hover-diff') || null;
    const hoverOverscrollBehaviorY = hoverDiff ? getComputedStyle(hoverDiff).overscrollBehaviorY : '';
    const hoverContentVisibility = hoverRow ? getComputedStyle(hoverRow.closest('[data-message-id]')).contentVisibility : '';
    const hoverClasses = hoverRow?.className || '';
    const reviewFiles = changeDialog?.querySelector('[data-codex-review-files]');
    const reviewFileList = changeDialog?.querySelector('.codex-review-file-list');
    const firstReviewFile = changeDialog?.querySelector('[data-codex-review-panel]');
    const firstReviewDiff = firstReviewFile?.querySelector('.codex-review-file-diff');
    const reviewFilesOpen = firstReviewFile?.open === true;
    if (firstReviewFile) firstReviewFile.open = false;
    const reviewFilesCollapse = firstReviewDiff ? firstReviewDiff.getClientRects().length === 0 : false;
    if (firstReviewFile) firstReviewFile.open = true;
    document.documentElement.classList.add('codex-review-panel-open');
    const chatPaddingRight = Number.parseFloat(getComputedStyle(document.querySelector('.chat-view.with-messages')).paddingRight) || 0;
    const darkReasoningColor = getComputedStyle(document.querySelector('.codex-transcript-narrative.type-reasoning p')).color;
    const addedBackground = added ? getComputedStyle(added).backgroundColor : '';
    const deletedBackground = deleted ? getComputedStyle(deleted).backgroundColor : '';
    const renderedLineNumberColumns = added ? getComputedStyle(added).gridTemplateColumns : '';
    const markdownQuoteRendered = document.querySelector('.message-markdown blockquote')?.textContent.includes('第二行仍属于引用') === true;
    const reviewFileListDisplay = reviewFileList ? getComputedStyle(reviewFileList).display : '';
    const reviewDialogWidth = changeDialog ? Number.parseFloat(getComputedStyle(changeDialog).width) : 0;
    const reviewResizer = changeDialog?.querySelector('[data-codex-review-resizer]') || null;
    const reviewResizerCursor = reviewResizer ? getComputedStyle(reviewResizer).cursor : '';
    const darkReviewPalette = {
      cardSurface: changeCard ? getComputedStyle(changeCard).backgroundColor : '',
      cardTitle: changeCard ? getComputedStyle(changeCard.querySelector('.codex-change-summary-title strong')).color : '',
      reviewButtonSurface: changeCard ? getComputedStyle(changeCard.querySelector('.codex-change-review-button')).backgroundColor : '',
      reviewButtonText: changeCard ? getComputedStyle(changeCard.querySelector('.codex-change-review-button')).color : '',
      hoverSurface: hoverDiff ? getComputedStyle(hoverDiff).backgroundColor : '',
      hoverAddSurface: hoverDiff ? getComputedStyle(hoverDiff.querySelector('.codex-review-diff-line.is-add')).backgroundColor : '',
      hoverAddText: hoverDiff ? getComputedStyle(hoverDiff.querySelector('.codex-review-diff-line.is-add > code')).color : '',
      hoverDeleteSurface: hoverDiff ? getComputedStyle(hoverDiff.querySelector('.codex-review-diff-line.is-delete')).backgroundColor : '',
      hoverDeleteText: hoverDiff ? getComputedStyle(hoverDiff.querySelector('.codex-review-diff-line.is-delete > code')).color : '',
      dialogSurface: changeDialog ? getComputedStyle(changeDialog).backgroundColor : '',
      dialogText: changeDialog ? getComputedStyle(changeDialog.querySelector('.codex-review-tab strong')).color : '',
      dialogAddText: changeDialog ? getComputedStyle(changeDialog.querySelector('.codex-review-diff-line.is-add > code')).color : '',
      dialogDeleteText: changeDialog ? getComputedStyle(changeDialog.querySelector('.codex-review-diff-line.is-delete > code')).color : '',
    };
    const reviewDialogReady = Boolean(changeDialog)
      && changeDialog.querySelectorAll('[data-codex-review-select]').length === 4
      && changeDialog.textContent.includes('\u4e0a\u4e00\u8f6e')
      && reviewFilesOpen
      && reviewFilesCollapse
      && changeDialog.querySelector('[data-codex-review-current]')?.textContent.includes('demo.css') === true
      && reviewFileListDisplay === 'block'
      && changeDialog.querySelectorAll('.codex-review-file').length === 4
      && reviewDialogWidth <= 720
      && changeDialog.querySelector('[data-codex-review-resizer][role="separator"]') !== null
      && reviewResizerCursor === 'ew-resize';
    let mountedPortal = null;
    let survivesMessageReplacement = false;
    let survivesFullRewire = false;
    let closesAfterSourceRemoval = false;
    let reviewPortalError = '';
    try {
      const mountPortal = (${mountPortalSource});
      const codexReviewPortalSourceMounted = (${portalSourceMountedSource});
      const cleanupPortal = (${cleanupPortalSource});
      document.querySelectorAll('[data-codex-review-dialog][data-codex-review-portaled="true"]').forEach((dialog) => dialog.remove());
      mountedPortal = mountPortal(document.querySelector('.codex-change-review-button'), { documentRef: document });
      mountedPortal?.setAttribute('open', '');
      const originalMessage = document.querySelector('[data-message-id="codex-diff-smoke"]');
      const replacementMessage = originalMessage?.cloneNode(true) || null;
      originalMessage?.replaceWith(replacementMessage);
      survivesMessageReplacement = mountedPortal?.isConnected === true && mountedPortal.open === true && codexReviewPortalSourceMounted(mountedPortal, { documentRef: document });
      survivesFullRewire = cleanupPortal(mountedPortal, { documentRef: document }) === false && mountedPortal?.isConnected === true;
      replacementMessage?.remove();
      closesAfterSourceRemoval = cleanupPortal(mountedPortal, { documentRef: document }) === true && mountedPortal?.isConnected === false;
    } catch (error) {
      reviewPortalError = String(error?.stack || error?.message || error);
    }
    return {
      operationSummary: operation.querySelector(':scope > summary')?.textContent.replace(/\\s+/g, ' ').trim() || '',
      approvalState: approval?.textContent.includes('需要确认一项操作') === true
        && approval?.querySelector('.codex-file-change-status.is-waiting')?.textContent.includes('等待批准') === true
        && approval?.querySelector('.codex-strict-comparison.is-pending') !== null,
      reasoningBatchActive: reasoningBatch?.open === true
        && reasoningBatch?.querySelector(':scope > summary')?.textContent.includes('正在执行 6 项操作') === true
        && reasoningBatch?.querySelector(':scope > summary')?.textContent.includes('点击展开') === false,
      fileCardCount: cards.length,
      absolutePathLeaked: operation.textContent.includes('/home/private/'),
      colorsDistinct: Boolean(added && deleted)
        && addedBackground !== deletedBackground
        && addedBackground !== 'rgba(0, 0, 0, 0)'
        && deletedBackground !== 'rgba(0, 0, 0, 0)',
      lineNumbersCorrect: addedNumbers[1] === '1' && deletedNumbers[0] === '1',
      headersNeutral: cssCard?.querySelectorAll('.codex-diff-line.is-meta').length === 2
        && cssCard?.querySelectorAll('.codex-diff-line.is-add').length === 1
        && cssCard?.querySelectorAll('.codex-diff-line.is-delete').length === 1,
      lineNumberColumns: renderedLineNumberColumns,
      binaryNotice: binaryCard?.textContent.includes('这是二进制文件变更') === true,
      imageSemantic: binaryCard?.textContent.includes('图片资源') === true
        && binaryCard?.querySelector('[data-preview-file]')?.textContent.includes('预览当前图片') === true
        && binaryCard?.textContent.includes('640 × 360') === true
        && binaryCard?.textContent.includes('1280 × 720') === true,
      documentSemantic: documentCard?.textContent.includes('Word 文档') === true
        && documentCard?.textContent.includes('标题、段落、列表和表格') === true
        && documentCard?.querySelector('.codex-semantic-diff-line.is-delete')?.textContent.includes('旧标题') === true
        && documentCard?.querySelector('.codex-semantic-diff-line.is-add')?.textContent.includes('新标题') === true,
      fileActions: documentCard?.querySelectorAll('[data-preview-file],[data-open-file],[data-show-file],[data-copy-file-path]').length === 7
        && documentCard?.querySelector('.codex-file-path-button[data-open-file]') !== null,
      provenanceVisible: documentCard?.textContent.includes('Janus 原生运行事件') === true
        && documentCard?.textContent.includes('Janus turn 开始快照') === true,
      longDiffCollapsed: longCard?.querySelector('.codex-diff-overflow:not([open]) > summary')?.textContent.includes('其余 6 行') === true,
      markdownQuoteRendered,
      darkReasoningColor,
      darkReasoningReadable: ['rgb(188, 199, 214)', 'rgb(203, 212, 223)'].includes(darkReasoningColor),
      finalChangeSummary: changeCard?.textContent.includes('已编辑 4 个文件') === true
        && changeCard?.textContent.includes('+246') === true
        && changeCard?.textContent.includes('-1') === true,
      hoverPreviewReady: Boolean(hoverPreview)
        && hoverDisplay === 'block'
        && hoverPreview.textContent.includes('demo.css')
        && hoverPlacement?.openAbove === true
        && hoverPlacement.maxHeight <= 410
        && hoverRow.classList.contains('is-preview-above')
        && hoverContentVisibility === 'visible',
      hoverScrollContained: hoverOverscrollBehaviorY === 'contain',
      hoverPlacement,
      hoverDisplay,
      hoverContentVisibility,
      hoverClasses,
      darkReviewPalette,
      reviewProbe: {
        template: Boolean(reviewTemplate),
        dialog: Boolean(changeDialog),
        selectCount: changeDialog?.querySelectorAll('[data-codex-review-select]').length || 0,
        lastTurn: changeDialog?.textContent.includes('\u4e0a\u4e00\u8f6e') === true,
        firstOpen: reviewFilesOpen,
        firstCollapsed: reviewFilesCollapse,
        current: changeDialog?.querySelector('[data-codex-review-current]')?.textContent || '',
        listDisplay: reviewFileListDisplay,
        fileCount: changeDialog?.querySelectorAll('.codex-review-file').length || 0,
        width: reviewDialogWidth,
        resizer: Boolean(changeDialog?.querySelector('[data-codex-review-resizer][role="separator"]')),
        resizerCursor: reviewResizerCursor,
      },
      reviewDialogReady,
      reviewDoesNotCompressChat: chatPaddingRight < 1,
      reviewPortalPersistence: Boolean(mountedPortal)
        && survivesMessageReplacement
        && survivesFullRewire
        && closesAfterSourceRemoval,
      reviewPortalError,
    };
  } catch (error) {
    return { topLevelError: String(error?.stack || error?.message || error) };
  } })()`;
  new Function(browserScript);
  const result = await browserWindow.webContents.executeJavaScript(browserScript);

  const browserProbeExcerpt = browserScript.split('\n').slice(138, 148).map((line, index) => `${index + 139}: ${line}`).join('\n');
  assert.equal(result.topLevelError, undefined, `renderer probe failed: ${result.topLevelError || ''}\n${browserProbeExcerpt}`);
  assert.match(result.operationSummary, /文件变更/);
  assert.equal(result.approvalState, true, 'native file approvals must remain visible with a waiting status');
  assert.equal(result.reasoningBatchActive, true, 'a reasoning batch with a waiting operation must remain expanded');
  assert.match(result.operationSummary, /修改 3 个，新增 1 个/);
  assert.match(result.operationSummary, /\+246 −1/);
  assert.equal(result.fileCardCount, 4, 'contiguous native file events must be grouped without duplicating the turn diff');
  assert.equal(result.absolutePathLeaked, false, 'file cards must display project-relative paths');
  assert.equal(result.colorsDistinct, true, `add/delete rows must use distinct colors: ${JSON.stringify(result)}`);
  assert.equal(result.lineNumbersCorrect, true, `old/new line numbers are incorrect: ${JSON.stringify(result)}`);
  assert.equal(result.headersNeutral, true, `unified diff headers must remain neutral: ${JSON.stringify(result)}`);
  assert.match(result.lineNumberColumns, /^46px 46px /);
  assert.equal(result.binaryNotice, true, 'binary changes must use a readable fallback');
  assert.equal(result.imageSemantic, true, 'image changes must explain current-version preview semantics');
  assert.equal(result.documentSemantic, true, 'Office changes must explain document-level preview semantics');
  assert.equal(result.fileActions, true, 'file changes must expose preview, open, reveal, copy, and clickable-path actions');
  assert.equal(result.provenanceVisible, true, 'native change provenance and derived comparison provenance must remain distinct');
  assert.equal(result.longDiffCollapsed, true, 'long diffs must collapse overflow lines by default');
  assert.equal(result.markdownQuoteRendered, true, 'Markdown quote markers must render as a blockquote instead of literal > text');
  assert.equal(result.darkReasoningReadable, true, `dark mode reasoning text must use the readable high-contrast color, received ${result.darkReasoningColor}`);
  assert.equal(result.finalChangeSummary, true, 'the final answer must summarize unique changed files and line counts');
  assert.equal(result.hoverPreviewReady, true, `hover diff previews must escape message paint containment and flip away from a clipped edge: ${JSON.stringify(result)}`);
  assert.equal(result.hoverScrollContained, true, 'hover diff scrolling must not chain into the conversation at either boundary');
  assert.deepEqual(result.darkReviewPalette, {
    cardSurface: 'rgb(32, 37, 45)',
    cardTitle: 'rgb(231, 237, 245)',
    reviewButtonSurface: 'rgb(42, 48, 57)',
    reviewButtonText: 'rgb(238, 243, 248)',
    hoverSurface: 'rgb(24, 29, 36)',
    hoverAddSurface: 'rgb(23, 53, 39)',
    hoverAddText: 'rgb(198, 242, 213)',
    hoverDeleteSurface: 'rgb(59, 32, 36)',
    hoverDeleteText: 'rgb(255, 209, 211)',
    dialogSurface: 'rgb(32, 37, 45)',
    dialogText: 'rgb(231, 237, 245)',
    dialogAddText: 'rgb(198, 242, 213)',
    dialogDeleteText: 'rgb(255, 209, 211)',
  }, 'dark review cards, buttons, hover diffs, and review panel must use the high-contrast palette');
  assert.equal(result.reviewDialogReady, true, `the review sidebar must expose collapsible per-file diffs, the last-turn scope, and a width resizer: ${JSON.stringify(result)}`);
  assert.equal(result.reviewDoesNotCompressChat, true, 'opening the review panel must not add a large right padding to the chat');
  assert.equal(result.reviewPortalPersistence, true, `the review sidebar must survive message replacement and close only after its source leaves the conversation: ${JSON.stringify(result)}`);
  process.stdout.write('Renderer Codex diff smoke passed.\n');
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
