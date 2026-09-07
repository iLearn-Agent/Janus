import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { artifactFileInfo, sessionOutputsDir } from './artifacts.js';
import { bundledCodexBinary } from './codex.js';
import { generateImageArtifact } from './imageGeneration.js';
import { imageGenerationProviderState } from './imageProvider.js';
import {
  completeImageGeneration,
  failImageGeneration,
  imageGenerationUsageStatus,
  reserveImageGeneration,
} from './managedProviderUsage.js';
import { projectRoot } from './paths.js';
import { pythonEnvironment, resolvePythonInvocation } from './python.js';
import { classifyPptIntent } from './pptIntent.js';
import { readZipEntries } from './zip.js';
import { normalizePptStyleId, pptStyleForAgentId } from '../shared/pptAgents.js';
import { getApplicationLogger } from '../shared/logging/index.js';

const pptLogger = getApplicationLogger('ppt-renderer');
const PPT_REQUIRED_PYTHON_MODULES = Object.freeze(['pptx', 'PIL', 'fitz', 'lxml']);

export function userExplicitlyRequestsPptArtifact(userMessage) {
  return classifyPptIntent(userMessage).creation;
}

export function shouldAttachPptArtifact({ departmentId = '', agentId = '', explicitPptMode = false } = {}, userMessage, answer = '') {
  if (departmentId !== 'ppt_department' && agentId !== 'ppt') return false;
  const intent = classifyPptIntent(userMessage, { explicitPptMode });
  if (!intent.creation) return false;
  if (intent.mentionsPpt) return shouldRenderPptArtifact(userMessage, answer);
  return explicitPptMode;
}

export function shouldRenderPptArtifact(userMessage, assistantAnswer) {
  const text = `${userMessage || ''}\n${assistantAnswer || ''}`.toLowerCase();
  const textOnlyMarkers = [
    'final product format: markdown',
    'final product format: json',
    'final product format: yaml',
    'final product format: csv',
    'text only',
    'plain text',
    'markdown table',
  ];
  if (textOnlyMarkers.some((marker) => text.includes(marker))) return false;
  return /(ppt|slide|slides|deck|presentation|group meeting|pitch|defense|幻灯片|演示文稿|课件)/i.test(text);
}

function markdownTableBlocks(text = '') {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      current.push(line);
      continue;
    }
    if (current.length) blocks.push(current);
    current = [];
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function splitMarkdownRow(line = '') {
  return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function detailedPptTable(text = '') {
  const blocks = markdownTableBlocks(text);
  const candidates = blocks.filter((block) => {
    const header = splitMarkdownRow(block[0]).map((cell) => cell.toLowerCase());
    return header.includes('title') && (header.includes('message') || header.includes('visual'));
  });
  return candidates.sort((left, right) => right.length - left.length)[0] || [];
}

function pptTableTitles(table = []) {
  if (table.length < 3) return [];
  const header = splitMarkdownRow(table[0]).map((cell) => cell.toLowerCase());
  const titleIndex = header.indexOf('title');
  if (titleIndex < 0) return [];
  return table.slice(2).map((line) => splitMarkdownRow(line)[titleIndex] || '').map((title) => (
    title.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim()
  )).filter(Boolean);
}

function fencedBlock(text = '', language = '') {
  const escaped = String(language).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp('```' + escaped + '\\b[^\\n]*\\n([\\s\\S]*?)```', 'i'));
  return match ? { full: match[0], content: match[1].trim() } : null;
}

function compactPptTitle(title = '') {
  const clean = String(title || '').replace(/^[•·\-\s]+/, '').trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

const PPT_IMAGE_LAYOUT_PRIORITY = new Map([
  ['media_showcase', 0],
  ['case_gallery', 1],
  ['basic_content', 2],
  ['evidence_grid', 3],
  ['motivation_compare', 4],
  ['challenge_map', 5],
]);

function cleanPptImagePrompt(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function explicitPptImagePrompt(visual = '') {
  const text = cleanPptImagePrompt(visual);
  const match = /(?:生成插图|生成图片|图片提示词|gpt-image(?:-2)?|generate(?:d)?\s+(?:an?\s+)?(?:image|illustration))\s*[:：]\s*(.+)$/i.exec(text);
  return cleanPptImagePrompt(match?.[1] || '');
}

export function extractPptImageRequests(assistantAnswer = '', { selectedStyle = 'general', minimumImages = 1, maxImages = 2 } = {}) {
  const hiddenPlan = fencedBlock(assistantAnswer, 'janus-slide-plan');
  const table = detailedPptTable(hiddenPlan?.content || assistantAnswer);
  if (table.length < 3) return [];
  const header = splitMarkdownRow(table[0]).map((cell) => cell.toLowerCase());
  const layoutIndex = header.indexOf('layout_id');
  const titleIndex = header.indexOf('title');
  const messageIndex = header.indexOf('message');
  const visualIndex = header.indexOf('visual');
  const rows = table.slice(2).map((line, index) => {
    const cells = splitMarkdownRow(line);
    return {
      slideIndex: index + 1,
      layoutId: cleanPptImagePrompt(cells[layoutIndex] || '').toLowerCase(),
      title: cleanPptImagePrompt(cells[titleIndex] || `Slide ${index + 1}`),
      message: cleanPptImagePrompt(cells[messageIndex] || ''),
      visual: cleanPptImagePrompt(cells[visualIndex] || ''),
      prompt: explicitPptImagePrompt(cells[visualIndex] || ''),
    };
  });
  const limit = Math.max(0, Math.min(Number(maxImages) || 0, rows.length));
  const selected = rows.filter((row) => row.prompt);
  if (selected.length < Math.min(Math.max(0, Number(minimumImages) || 0), limit)) {
    const bodyRows = rows.filter((row) => row.slideIndex > 1 && row.slideIndex < rows.length);
    const fallbackRows = bodyRows.length ? bodyRows : rows.filter((row) => row.slideIndex > 1);
    const candidate = fallbackRows
      .filter((row) => !selected.some((item) => item.slideIndex === row.slideIndex))
      .sort((left, right) => (
        (PPT_IMAGE_LAYOUT_PRIORITY.get(left.layoutId) ?? 20) - (PPT_IMAGE_LAYOUT_PRIORITY.get(right.layoutId) ?? 20)
        || left.slideIndex - right.slideIndex
      ))[0];
    if (candidate) {
      selected.push({
        ...candidate,
        prompt: [
          `Create a presentation-support editorial illustration for the slide “${candidate.title}”.`,
          candidate.message ? `Visualize this concrete idea: ${candidate.message}.` : '',
          `Use a coherent ${selectedStyle || 'general'} presentation style, 16:9 landscape composition, clear subject hierarchy, credible materials and lighting.`,
          'Do not include words, labels, numbers, charts, user interfaces, watermarks, or logos.',
        ].filter(Boolean).join(' '),
      });
    }
  }
  return selected.slice(0, limit).map((request) => ({
    slideIndex: request.slideIndex,
    title: request.title,
    prompt: request.prompt,
  }));
}

export async function generatePptHostImages({
  root,
  store = null,
  userId = 'desktop',
  accountWorkspaceId = 'workspace_personal',
  quotaEventPrefix = '',
  outputRoot = '',
  artifactRoot = root,
  sessionId,
  assistantAnswer,
  selectedStyle = 'general',
  sourceImagePaths = [],
  imageProvider = null,
  onProgress = null,
  signal = null,
} = {}) {
  const configuredImageLimit = Number(process.env.JANUS_PPT_IMAGEGEN_MAX ?? 2);
  const configuredMaxImages = Number.isFinite(configuredImageLimit)
    ? Math.max(0, Math.min(4, Math.floor(configuredImageLimit)))
    : 2;
  const providerState = imageProvider || imageGenerationProviderState(root);
  let quotaStatus = null;
  if (store?.db) {
    try {
      quotaStatus = imageGenerationUsageStatus(store, userId, { providerState });
    } catch {
      // Quota diagnostics must not make an otherwise renderable deck fail.
    }
  }
  const quotaRemaining = quotaStatus?.imageGenerationLimited
    ? Math.max(0, Number(quotaStatus.dailyImagesRemaining) || 0)
    : configuredMaxImages;
  const maxImages = Math.min(configuredMaxImages, quotaRemaining);
  const skippedReason = configuredMaxImages === 0
    ? 'disabled'
    : quotaStatus?.imageGenerationLimited && quotaRemaining === 0
      ? 'quota_exhausted'
      : '';
  const requests = extractPptImageRequests(assistantAnswer, {
    selectedStyle,
    minimumImages: sourceImagePaths.length || maxImages === 0 ? 0 : 1,
    maxImages,
  });
  if (!requests.length) {
    if (skippedReason === 'quota_exhausted') {
      onProgress?.({
        phase: 'image',
        status: 'skipped',
        phase_current: 0,
        phase_total: 0,
        message: '今日图片额度已用完，将跳过生成配图并继续制作可编辑 PPTX',
      });
    }
    return { images: {}, errors: [], quotaStatus, skippedReason };
  }
  const resolvedArtifactRoot = path.resolve(artifactRoot || root);
  const requestedOutputRoot = String(outputRoot || '').trim();
  const sessionOutputRoot = !requestedOutputRoot || path.resolve(requestedOutputRoot) === resolvedArtifactRoot
    ? sessionOutputsDir(resolvedArtifactRoot, String(sessionId || 'ppt'))
    : path.resolve(requestedOutputRoot);
  const outputDir = path.join(sessionOutputRoot, 'ppt-assets', 'host-imagegen');
  const images = {};
  const errors = [];
  let completed = 0;
  for (const request of requests) {
    if (signal?.aborted) throw signal.reason || new Error('PPT image generation cancelled.');
    onProgress?.({
      phase: 'image',
      status: 'running',
      current_slide: request.slideIndex,
      phase_current: completed,
      phase_total: requests.length,
      slide_title: request.title,
      message: `正在复用图片生成服务，为第 ${request.slideIndex} 页生成配图：${request.title}`,
    });
    const quotaEventKey = `ppt-image-generation:${quotaEventPrefix || sessionId}:${request.slideIndex}`;
    let quotaReserved = false;
    const imageTimeout = pptImageTimeoutSignal(signal);
    try {
      if (store?.db) {
        reserveImageGeneration(store, {
          userId,
          accountWorkspaceId,
          executionId: quotaEventPrefix,
          sessionId,
          eventKey: quotaEventKey,
          agentId: 'ppt',
          model: process.env.JANUS_IMAGE_MODEL || 'gpt-image-2',
          providerState,
        });
        quotaReserved = true;
      }
      const artifact = await generateImageArtifact({
        root,
        outputRoot: outputDir,
        artifactRoot,
        sessionId,
        prompt: request.prompt,
        model: process.env.JANUS_IMAGE_MODEL || 'gpt-image-2',
        quality: process.env.JANUS_PPT_IMAGEGEN_QUALITY || 'auto',
        size: process.env.JANUS_PPT_IMAGEGEN_SIZE || '1024x1024',
        signal: imageTimeout.signal,
      });
      if (artifact?.path && fs.existsSync(artifact.path)) {
        images[request.slideIndex] = path.resolve(artifact.path);
        if (quotaReserved) completeImageGeneration(store, quotaEventKey, { userId, providerState });
        quotaReserved = false;
      } else {
        errors.push(`Slide ${request.slideIndex}: shared image service returned no local image file.`);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = imageTimeout.timedOut
        ? `PPT image generation timed out after ${Math.ceil(imageTimeout.timeoutMs / 1000)} seconds`
        : compact(error?.message || error, 1200);
      errors.push(`Slide ${request.slideIndex}: shared image service failed: ${reason}`);
    } finally {
      imageTimeout.cleanup();
      if (quotaReserved) failImageGeneration(store, quotaEventKey, { userId, providerState });
      completed += 1;
      onProgress?.({
        phase: 'image',
        status: images[request.slideIndex] ? 'completed' : 'failed',
        current_slide: request.slideIndex,
        phase_current: completed,
        phase_total: requests.length,
        slide_title: request.title,
        message: images[request.slideIndex]
          ? `第 ${request.slideIndex} 页配图已生成，将直接插入 PPT`
          : `第 ${request.slideIndex} 页配图未生成，将继续制作 PPT`,
      });
    }
  }
  return { images, errors, quotaStatus, skippedReason };
}

function pptImageTimeoutSignal(parentSignal = null) {
  const timeoutMs = Math.max(5_000, Number(process.env.JANUS_PPT_IMAGE_REQUEST_TIMEOUT_MS || 60_000));
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('PPT rendering was stopped.'));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`PPT image generation timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timeoutMs,
    get timedOut() { return timedOut; },
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    },
  };
}

export function normalizePptAssistantAnswer(answer = '', { artifactPending = true } = {}) {
  const text = String(answer || '').trim();
  if (!text) return '';
  const hiddenPlan = fencedBlock(text, 'janus-slide-plan');
  const table = detailedPptTable(hiddenPlan?.content || text);
  const titles = pptTableTitles(table);
  if (!table.length || !titles.length) return text;
  const deckSpec = fencedBlock(text, 'janus-deck-spec');
  const summary = [
    `PPT 页面结构已整理，共 ${titles.length} 页：`,
    '',
    ...titles.map((title, index) => `- 第 ${index + 1} 页：${compactPptTitle(title) || '页面主题'}`),
    '',
    artifactPending ? '页面结构已完成，正在生成和校验可编辑 PPTX。' : '页面结构已整理完成。',
  ].join('\n');
  const planFence = `\`\`\`janus-slide-plan\n${table.join('\n')}\n\`\`\``;
  return [summary, planFence, deckSpec?.full || ''].filter(Boolean).join('\n\n');
}

export function userExplicitlyRequestsPptNotes(userMessage = '') {
  const text = String(userMessage || '');
  const notesTerms = /(speaker[\s_-]*notes?|presenter[\s_-]*notes?|演讲者备注|演讲备注|逐页备注|备注文稿|讲稿|演讲稿|汇报稿|口播稿|解说稿|文稿文件)/i;
  if (!notesTerms.test(text)) return false;
  const negative = new RegExp(
    `(?:不要|不用|无需|不需要|别|无需输出|不要输出|不导出|不生成|without|no|do not|don't).{0,16}${notesTerms.source}`,
    'i',
  );
  return !negative.test(text);
}

export async function renderPptArtifact({
  root,
  store = null,
  accountWorkspaceId = 'workspace_personal',
  quotaEventPrefix = '',
  outputRoot = root,
  artifactRoot = outputRoot,
  userId = 'desktop',
  sessionId,
  agentId = 'ppt',
  userMessage = '',
  assistantAnswer = '',
  selectedStyle = 'general',
  selectedTemplate = 'none',
  sourceImagePaths = [],
  imageProvider = null,
  onProgress = null,
  signal = null,
} = {}) {
  if (!root) throw new Error('PPT renderer root is required.');
  const hostImageResult = await generatePptHostImages({
    root,
    store,
    userId,
    accountWorkspaceId,
    quotaEventPrefix,
    outputRoot,
    artifactRoot,
    sessionId,
    assistantAnswer,
    selectedStyle,
    sourceImagePaths,
    imageProvider,
    onProgress,
    signal,
  });
  const payload = {
    root,
    user_id: userId || 'desktop',
    agent_id: agentId || 'ppt',
    session_id: sessionId || `session-${Date.now()}`,
    user_message: userMessage,
    assistant_answer: assistantAnswer,
    selected_style: selectedStyle || 'general',
    selected_template: selectedTemplate || 'none',
    source_image_paths: sourceImagePaths,
    pre_generated_image_paths: hostImageResult.images,
    host_imagegen_errors: hostImageResult.errors,
    enable_imagegen: false,
    minimum_content_images: Object.keys(hostImageResult.images).length || sourceImagePaths.length ? 1 : 0,
    include_notes_artifact: userExplicitlyRequestsPptNotes(userMessage),
  };
  const rendererStartedAt = Date.now();
  let effectiveAssistantAnswer = assistantAnswer;
  const recover = () => recoverPartialPptResult({
    root,
    outputRoot,
    sessionId: payload.session_id,
    startedAt: rendererStartedAt,
    assistantAnswer: effectiveAssistantAnswer,
    selectedStyle,
    selectedTemplate,
    includeNotes: payload.include_notes_artifact,
  });
  let rawResult;
  try {
    const raw = await runPythonRenderer(payload, onProgress, signal);
    rawResult = JSON.parse(raw);
  } catch (initialError) {
    let error = initialError;
    if (pptSlidePlanParseError(error)) {
      effectiveAssistantAnswer = fallbackPptAnswer(userMessage, { styleId: selectedStyle, agentId });
      payload.assistant_answer = effectiveAssistantAnswer;
      payload.pre_generated_image_paths = {};
      payload.minimum_content_images = sourceImagePaths.length ? 1 : 0;
      onProgress?.({
        phase: 'parse',
        status: 'recovered',
        phase_current: 0,
        phase_total: 1,
        message: '页面表格式无法解析，正在使用保底页面结构继续生成 PPTX',
      });
      try {
        const raw = await runPythonRenderer(payload, onProgress, signal);
        rawResult = JSON.parse(raw);
      } catch (retryError) {
        error = retryError;
      }
    } else if (pptContentRenderRetryable(error)) {
      effectiveAssistantAnswer = simplifiedPptAnswer(assistantAnswer, userMessage, {
        styleId: selectedStyle,
        agentId,
      });
      payload.assistant_answer = effectiveAssistantAnswer;
      payload.selected_template = 'none';
      payload.pre_generated_image_paths = {};
      payload.minimum_content_images = sourceImagePaths.length ? 1 : 0;
      onProgress?.({
        phase: 'render',
        status: 'recovered',
        phase_current: 0,
        phase_total: 1,
        message: '复杂页面渲染未完成，正在保留原页面内容并切换为基础可编辑布局',
      });
      pptLogger.warn('ppt_renderer_simplified_retry', {
        error,
        data: { sessionId: payload.session_id || '', selectedStyle, selectedTemplate },
      });
      try {
        const raw = await runPythonRenderer(payload, onProgress, signal);
        rawResult = JSON.parse(raw);
      } catch (retryError) {
        const combined = new Error(
          `Initial PPT render failed: ${compact(error?.message || error, 1800)}. `
          + `Simplified-layout retry failed: ${compact(retryError?.message || retryError, 1800)}.`,
        );
        combined.code = retryError?.code || error?.code || 'ppt_renderer_retry_failed';
        error = combined;
      }
    }
    if (!rawResult) {
      const recoverable = recover();
      if (!recoverable) throw error;
      rawResult = recoverable;
      onProgress?.({
        phase: 'preview',
        status: 'recovered',
        current_slide: recoverable.slide_count,
        total_slides: recoverable.slide_count,
        phase_current: 1,
        phase_total: 1,
        message: /PPT renderer timed out/i.test(String(error?.message || error || ''))
          ? '\u9884\u89c8\u6216\u6821\u9a8c\u9636\u6bb5\u8d85\u65f6\uff0c\u4f46\u53ef\u7f16\u8f91 PPTX \u5df2\u5b8c\u6574\u751f\u6210\uff0c\u6b63\u5728\u76f4\u63a5\u4ea4\u4ed8\u6587\u4ef6'
          : 'PPTX \u5df2\u751f\u6210\u4f46\u6e32\u67d3\u8fdb\u7a0b\u672a\u6b63\u5e38\u8fd4\u56de\uff0c\u5df2\u4ece\u5b8c\u6574\u6587\u4ef6\u4e2d\u6062\u590d\u5e76\u7ee7\u7eed\u4ea4\u4ed8',
      });
    }
  }

  try {
    return materializePptResult(rawResult, { root, outputRoot, artifactRoot, selectedTemplate });
  } catch (error) {
    const recoverable = recover();
    if (!recoverable) throw error;
    onProgress?.({
      phase: 'preview',
      status: 'recovered',
      current_slide: recoverable.slide_count,
      total_slides: recoverable.slide_count,
      phase_current: 1,
      phase_total: 1,
      message: 'PPTX \u5df2\u751f\u6210\u4f46\u4ea4\u4ed8\u5143\u6570\u636e\u6574\u7406\u5931\u8d25\uff0c\u5df2\u4ece\u5b8c\u6574\u6587\u4ef6\u4e2d\u6062\u590d\u5e76\u7ee7\u7eed\u4ea4\u4ed8',
    });
    return materializePptResult(recoverable, { root, outputRoot, artifactRoot, selectedTemplate });
  }
}

function pptSlidePlanParseError(error) {
  return /(?:未能从 agent 回答中解析出 PPT 页面表|Missing render payload|slide plan)/i
    .test(String(error?.message || error || ''));
}

function pptContentRenderRetryable(error) {
  const raw = String(error?.message || error || '');
  return !/(?:AbortError|stopped by the user|timed out|Python runtime not found|required modules|No module named|ModuleNotFoundError|ImportError|DLL load failed|renderer script not found|can't open file|cannot open file|ENOSPC|no space left|EACCES|EPERM|permission denied)/i.test(raw);
}

function simplifiedPptAnswer(assistantAnswer = '', userMessage = '', { styleId = '', agentId = 'ppt' } = {}) {
  const hiddenPlan = fencedBlock(assistantAnswer, 'janus-slide-plan');
  const table = detailedPptTable(hiddenPlan?.content || assistantAnswer);
  if (table.length < 3) return fallbackPptAnswer(userMessage, { styleId, agentId });
  const header = splitMarkdownRow(table[0]);
  const normalizedHeader = header.map((cell) => cell.toLowerCase());
  const layoutIndex = normalizedHeader.indexOf('layout_id');
  const visualIndex = normalizedHeader.indexOf('visual');
  const rows = table.slice(2).map((line) => {
    const cells = splitMarkdownRow(line);
    while (cells.length < header.length) cells.push('');
    if (layoutIndex >= 0) cells[layoutIndex] = 'basic_content';
    if (visualIndex >= 0) cells[visualIndex] = '可编辑文本框与基础图形';
    return `| ${cells.slice(0, header.length).join(' | ')} |`;
  });
  const separator = `| ${header.map(() => '---').join(' | ')} |`;
  return normalizePptAssistantAnswer([`| ${header.join(' | ')} |`, separator, ...rows].join('\n'));
}

function materializePptResult(rawResult, { root = '', outputRoot = '', artifactRoot = outputRoot, selectedTemplate = 'none' } = {}) {
  const result = relocatePptResult(rawResult, { root, outputRoot });
  const artifactBase = artifactRoot || outputRoot || root;
  const deckPath = absoluteExistingPath(result.deck, 'PPTX deck');
  const notesPath = result.notes ? absoluteExistingPath(result.notes, 'speaker notes') : '';
  const pdfPath = result.pdf && fs.existsSync(result.pdf) ? path.resolve(result.pdf) : '';
  const coverPath = result.cover && fs.existsSync(result.cover) ? path.resolve(result.cover) : '';
  const slideImagePaths = Array.isArray(result.slide_images)
    ? result.slide_images.map((item) => (item && fs.existsSync(item) ? path.resolve(item) : '')).filter(Boolean)
    : [];
  const deckFile = artifactFileInfo(artifactBase, deckPath);
  const notesFile = notesPath ? artifactFileInfo(artifactBase, notesPath) : null;
  const pdfFile = pdfPath ? artifactFileInfo(artifactBase, pdfPath, { kind: 'pdf', content_type: 'application/pdf' }) : null;
  const coverFile = coverPath ? artifactFileInfo(artifactBase, coverPath, { kind: 'image', content_type: 'image/png' }) : null;
  const slideImageFiles = slideImagePaths.map((imagePath, index) => artifactFileInfo(artifactBase, imagePath, {
    kind: 'image',
    content_type: 'image/png',
    name: `slide-${String(index + 1).padStart(2, '0')}.png`,
  }));
  const preview = result.preview || {};
  const warnings = Array.isArray(result.preview_warnings) ? result.preview_warnings.filter(Boolean) : [];
  const notesExcerpt = [
    preview.notes_excerpt || '',
    warnings.length ? `Preview notes: ${warnings.join(' ')}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    kind: 'ppt',
    deck: deckPath,
    notes: notesPath,
    pdf: pdfPath,
    cover: coverPath,
    slide_images: slideImagePaths,
    deck_name: deckFile.name,
    notes_name: notesFile?.name || '',
    deck_url: deckFile.file_url,
    notes_url: notesFile?.file_url || '',
    deck_render_url: deckFile.render_url,
    notes_render_url: notesFile?.render_url || '',
    deck_pdf_url: pdfFile?.file_url || '',
    deck_cover_url: coverFile?.file_url || '',
    deck_slide_urls: slideImageFiles.map((file) => file.file_url),
    preview_render_mode: result.preview_render_mode || (pdfPath ? 'office' : 'fallback'),
    template: result.template || selectedTemplate || 'none',
    template_label: result.template_label || '',
    style_id: result.style_id || '',
    style_label: result.style_label || '',
    slide_count: Number(result.slide_count || 0),
    source_visual_count: Number(result.source_visual_count || 0),
    recovered_after_timeout: Boolean(result.recovered_after_timeout),
    preview_warnings: warnings,
    deck_file: deckFile,
    notes_file: notesFile,
    pdf_file: pdfFile,
    cover_file: coverFile,
    slide_image_files: slideImageFiles,
    preview: {
      kind: 'ppt',
      title: compact(preview.title || deckFile.name.replace(/\.[^.]+$/, ''), 90),
      subtitle: compact(preview.subtitle || `${result.slide_count || ''} \u9875 / ${result.style_label || ''} / ${result.template_label || ''}`, 160),
      notes_excerpt: notesFile ? compact(notesExcerpt || 'Speaker notes are available.', 520) : '',
    },
  };
}

export function recoverPartialPptResult({
  root = '',
  outputRoot = '',
  sessionId = '',
  startedAt = 0,
  assistantAnswer = '',
  selectedStyle = 'general',
  selectedTemplate = 'none',
  includeNotes = false,
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!root || !cleanSessionId) return null;
  const threshold = Math.max(0, Number(startedAt || 0) - 5_000);
  const candidates = [];
  for (const outputBase of partialPptSearchBases({ root, outputRoot })) {
    for (const entry of fs.readdirSync(outputBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${cleanSessionId}-`)) continue;
      const directory = path.join(outputBase, entry.name);
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!child.isFile() || path.extname(child.name).toLowerCase() !== '.pptx') continue;
        const deck = path.join(directory, child.name);
        const stat = fs.statSync(deck);
        if (stat.mtimeMs < threshold || !isCompletePptxPackage(deck, stat.size)) continue;
        candidates.push({ directory, deck, mtimeMs: stat.mtimeMs });
      }
    }
  }
  const latest = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (!latest) return null;
  const optionalFile = (name) => {
    const candidate = path.join(latest.directory, name);
    return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : '';
  };
  const slidePreviewDir = path.join(latest.directory, 'slide_previews');
  const slideImages = fs.existsSync(slidePreviewDir)
    ? fs.readdirSync(slidePreviewDir)
      .filter((name) => /^slide-\d+\.png$/i.test(name))
      .sort()
      .map((name) => path.join(slidePreviewDir, name))
      .filter((candidate) => fs.statSync(candidate).isFile())
    : [];
  const slideCount = pptTableTitles(detailedPptTable(fencedBlock(assistantAnswer, 'janus-slide-plan')?.content || assistantAnswer)).length;
  const packageMetadata = pptPackageRenderMetadata(latest.deck);
  return {
    deck: latest.deck,
    notes: includeNotes ? optionalFile('speaker_notes.md') : '',
    pdf: optionalFile('deck.pdf'),
    cover: optionalFile('cover.png'),
    slide_images: slideImages,
    preview_render_mode: optionalFile('deck.pdf') ? 'office' : 'fallback',
    slide_count: slideCount,
    style_id: packageMetadata.styleId || normalizePptStyleId(selectedStyle),
    style_label: '',
    template: packageMetadata.templateId || selectedTemplate || 'none',
    template_label: '',
    source_visual_count: 0,
    recovered_after_timeout: true,
    preview_warnings: ['预览或最终校验阶段超时；已验证并交付完整的可编辑 PPTX 文件。'],
    preview: {
      kind: 'ppt',
      title: path.basename(latest.deck, path.extname(latest.deck)),
      subtitle: `${slideCount || ''} 页 · 已从超时渲染中恢复`,
      notes_excerpt: '',
    },
  };
}

function pptPackageRenderMetadata(deckPath = '') {
  try {
    const core = readZipEntries(deckPath).get('docProps/core.xml')?.toString('utf8') || '';
    const encodedKeywords = /<cp:keywords>([\s\S]*?)<\/cp:keywords>/i.exec(core)?.[1] || '';
    const keywords = encodedKeywords
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .split(',')
      .map((item) => item.trim());
    return {
      styleId: keywords[2] || '',
      templateId: keywords[3] || '',
    };
  } catch {
    return { styleId: '', templateId: '' };
  }
}

function partialPptSearchBases({ root = '', outputRoot = '' } = {}) {
  const bases = [];
  const addBase = (candidate) => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
    if (!bases.includes(resolved)) bases.push(resolved);
  };
  for (const baseRoot of [root, outputRoot].filter(Boolean)) {
    addBase(path.join(baseRoot, 'outputs', 'ppt_department'));
  }
  if (outputRoot && path.resolve(outputRoot) !== path.resolve(root || '.')) addBase(outputRoot);
  return bases;
}

function isCompletePptxPackage(filePath, knownSize = 0) {
  const size = Number(knownSize || fs.statSync(filePath).size || 0);
  if (size < 1_024) return false;
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(descriptor, head, 0, head.length, 0);
    if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(descriptor, tail, 0, tailLength, size - tailLength);
    return tail.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function relocatePptResult(result = {}, { root = '', outputRoot = '' } = {}) {
  const targetRoot = path.resolve(outputRoot || root || '.');
  const runtimeRoot = path.resolve(root || '.');
  if (targetRoot === runtimeRoot) return result;
  const sourceDeck = path.resolve(String(result.deck || ''));
  if (!sourceDeck || !fs.existsSync(sourceDeck)) return result;
  const sourceDir = path.dirname(sourceDeck);
  const targetDir = uniqueDirectoryPath(path.join(targetRoot, path.basename(sourceDir)));
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  try {
    fs.renameSync(sourceDir, targetDir);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
  const relocatePath = (value = '') => {
    if (!value) return '';
    const resolved = path.resolve(String(value));
    const relative = path.relative(sourceDir, resolved);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? path.join(targetDir, relative)
      : resolved === sourceDir ? targetDir : value;
  };
  return {
    ...result,
    deck: relocatePath(result.deck),
    notes: relocatePath(result.notes),
    pdf: relocatePath(result.pdf),
    cover: relocatePath(result.cover),
    slide_images: Array.isArray(result.slide_images) ? result.slide_images.map(relocatePath) : [],
  };
}

function uniqueDirectoryPath(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  for (let index = 2; index < 10_000; index += 1) {
    const next = `${candidate}-${index}`;
    if (!fs.existsSync(next)) return next;
  }
  throw new Error(`Unable to allocate a unique PPT artifact directory: ${path.basename(candidate)}`);
}

export function fallbackPptAnswer(userMessage = '', { styleId = '', agentId = 'ppt' } = {}) {
  const title = compact(userMessage || 'PPT', 42);
  const isProject = normalizePptStyleId(styleId || pptStyleForAgentId(agentId)) === 'major_project';
  const rows = isProject
    ? [
        ['project_target_map', '项目背景与目标', '• 明确项目问题、应用场景和验收目标 • 说明现有方案不足与改进空间 • 给出本次汇报的技术边界', '目标-方法-证据映射图', '可编辑痛点卡片 + 目标框', '开场交代项目背景、需求来源和本次汇报范围。', '60s'],
        ['domain_object_map', '研究对象与关键问题', '• 抽象出核心对象、关系和约束 • 识别影响效果的关键变量 • 将业务问题转为可验证技术问题', '对象关系图', '可编辑对象关系图', '解释为什么这些对象和变量决定项目成败。', '80s'],
        ['technical_route', '总体技术路线', '• 按数据、模型、评测和交付形成闭环 • 每个阶段都有输入、输出和质量标准 • 路线兼顾可解释性与可落地性', '四阶段技术路线图', '可编辑四阶段技术路线图', '强调路线不是单点模型，而是完整工程链路。', '90s'],
        ['workpackage_matrix', '阶段方法与模块设计', '• 拆分核心模块并说明职责 • 保持模块之间接口清晰 • 为后续迭代预留扩展空间', '模块-产出矩阵', '可编辑任务包矩阵', '逐一说明各模块承担的技术功能。', '90s'],
        ['evaluation_dashboard', '评测方案与结果呈现', '• 设计离线指标和场景化验证 • 对比基线方案和关键消融 • 用指标解释技术收益与局限', '指标仪表盘', '可编辑评测仪表盘', '说明如何证明方案有效，而不是只展示过程。', '80s'],
        ['risk_action_table', '风险、短板与下一步', '• 标出当前最主要技术风险 • 给出短板成因和改进路径 • 明确下一阶段里程碑和资源需求', '风险-行动矩阵', '可编辑风险行动表', '坦诚说明问题，并把问题连接到下一步计划。', '70s'],
        ['summary_takeaways', '总结', '• 项目已形成可验证的技术路径 • 关键模块具备继续迭代基础 • 后续聚焦稳定性、评测和交付闭环', '三点总结', '可编辑总结卡片', '收束项目价值并引出讨论。', '40s'],
      ]
    : [
        ['motivation_compare', title, '• 明确主题背景和汇报目标 • 用结构化页面降低理解成本 • 后续内容围绕方法、证据和结论展开', '封面主题视觉', '封面：标题 + 简洁学术视觉', '开场说明汇报主题、对象和听众收益。', '40s'],
        ['challenge_map', '研究动机与问题', '• 现实场景存在信息过载或效率瓶颈 • 现有方法难以同时满足准确性和可解释性 • 本汇报聚焦核心问题与解决路径', '挑战关系图', '可编辑挑战关系图', '说明为什么这个问题值得研究。', '70s'],
        ['method_pipeline', '基本概念与流程', '• 定义关键对象、输入和输出 • 拆解从数据到结果的主要步骤 • 强调流程中的反馈闭环', '四步流程图', '可编辑四步流程图', '帮助听众建立整体框架。', '90s'],
        ['ablation_matrix', '核心方法', '• 介绍主流技术路线和适用条件 • 对比不同方法的优势与限制 • 说明本主题中的关键设计取舍', '方法对比矩阵', '可编辑方法对比矩阵', '讲清楚方法之间的差异，而不是罗列术语。', '100s'],
        ['case_gallery', '实验或案例分析', '• 通过典型案例展示方法效果 • 结合指标或现象解释结果 • 标出仍需验证的假设', '案例页和结果标注', '案例页 + 结果 callout', '用证据支撑核心观点。', '90s'],
        ['evidence_grid', '挑战与发展趋势', '• 数据稀疏、泛化和可靠性仍是难点 • 多模态和大模型带来新的能力空间 • 可信、可控和可解释是重要方向', '挑战-趋势证据网格', '挑战-趋势双栏', '说明当前边界和未来机会。', '80s'],
        ['summary_takeaways', '总结与讨论', '• 本主题核心是提升匹配、理解和决策效率 • 方法需要结合场景、数据和评测目标 • 后续可继续展开算法细节或工程实现', '三点总结', '三点总结卡片', '收束整份汇报，并引出讨论。', '40s'],
      ];
  const header = '| layout_id | title | message | proof_object | visual | speaker_note | time |\n|---|---|---|---|---|---|---|';
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return normalizePptAssistantAnswer(`${header}\n${body}`);
}

export function pptProgressMilestones(elapsedMs) {
  const elapsedMinutes = Math.max(0, Math.floor(Number(elapsedMs || 0) / 60_000));
  const milestones = [5, 7, 10].filter((minute) => minute <= elapsedMinutes);
  for (let minute = 15; minute <= elapsedMinutes; minute += 5) milestones.push(minute);
  return milestones;
}

function rendererCancelledError() {
  const error = new Error('PPT rendering was stopped by the user.');
  error.name = 'AbortError';
  return error;
}

function terminateRendererProcess(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The renderer has already exited.
    }
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The renderer process group has already exited.
    }
  }, 5_000);
  forceTimer.unref?.();
}

function runPythonRenderer(payload, onProgress, signal = null) {
  const script = path.join(projectRoot, 'src', 'main', 'ppt_service', 'render_ppt.py');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(rendererCancelledError());
      return;
    }
    let invocation;
    try {
      if (!fs.existsSync(script)) throw new Error(`PPT renderer script not found: ${script}`);
      invocation = resolvePythonInvocation([script], {
        required: true,
        root: payload.root,
        requiredModules: PPT_REQUIRED_PYTHON_MODULES,
      });
    } catch (error) {
      pptLogger.error('ppt_renderer_preflight_failed', {
        error,
        data: { sessionId: payload.session_id || '', scriptExists: fs.existsSync(script) },
      });
      reject(error);
      return;
    }
    const managedCodexBin = process.env.JANUS_CODEX_BIN || bundledCodexBinary();
    let fileProtocol = null;
    let child;
    try {
      fileProtocol = invocation.packaged && process.platform === 'win32'
        ? createWindowsRendererProtocol(payload)
        : null;
      child = spawn(invocation.command, [
        ...invocation.args,
        ...(fileProtocol ? fileProtocol.arguments : []),
      ], {
        cwd: projectRoot,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: fileProtocol ? 'ignore' : ['pipe', 'pipe', 'pipe'],
        env: {
          ...pythonEnvironment({}, { root: payload.root, packaged: invocation.packaged }),
          ...(managedCodexBin ? { JANUS_CODEX_BIN: managedCodexBin } : {}),
          PYTHONIOENCODING: 'utf-8',
        },
      });
    } catch (error) {
      fileProtocol?.close();
      pptLogger.error('ppt_renderer_spawn_failed', {
        error,
        data: { sessionId: payload.session_id || '', pythonMode: invocation.packaged ? 'bundled' : 'external' },
      });
      reject(error);
      return;
    }
    pptLogger.info('ppt_renderer_started', {
      data: {
        sessionId: payload.session_id || '',
        pythonMode: invocation.packaged ? 'bundled' : 'external',
        ioMode: fileProtocol ? 'file_protocol' : 'pipes',
        scriptExists: true,
        selectedStyle: payload.selected_style || 'general',
        selectedTemplate: payload.selected_template || 'none',
        sourceImageCount: Array.isArray(payload.source_image_paths) ? payload.source_image_paths.length : 0,
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const startedAt = Date.now();
    let lastRendererProgressAt = startedAt;
    let lastRendererProgressMessage = 'PPTX 渲染进程已启动，等待 Python 返回首个阶段';
    if (typeof onProgress === 'function') {
      onProgress({
        phase: 'launch',
        phase_current: 0,
        phase_total: 1,
        message: lastRendererProgressMessage,
      });
    }
    const renderTimeoutMs = Math.max(60_000, Number(process.env.JANUS_PPT_RENDER_TIMEOUT_MS || 600_000));
    const renderTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateRendererProcess(child);
      deferFileProtocolCleanup();
      const silentSeconds = Math.max(0, Math.floor((Date.now() - lastRendererProgressAt) / 1000));
      const error = new Error(
        `PPT renderer timed out after ${Math.ceil(renderTimeoutMs / 1000)} seconds. `
        + `Last renderer stage: ${compact(lastRendererProgressMessage, 240)}. `
        + `No new renderer stage for ${silentSeconds} seconds.`,
      );
      error.code = 'ppt_renderer_timeout';
      pptLogger.error('ppt_renderer_timed_out', {
        error,
        durationMs: Date.now() - startedAt,
        data: {
          sessionId: payload.session_id || '',
          pythonMode: invocation.packaged ? 'bundled' : 'external',
          lastStage: lastRendererProgressMessage,
          silentSeconds,
        },
      });
      reject(error);
    }, renderTimeoutMs);
    renderTimeout.unref?.();
    const reportedMilestones = new Set();
    const progressTimer = typeof onProgress === 'function'
      ? setInterval(() => {
          for (const minute of pptProgressMilestones(Date.now() - startedAt)) {
            if (reportedMilestones.has(minute)) continue;
            reportedMilestones.add(minute);
            onProgress({
              phase: 'heartbeat',
              elapsed_minutes: minute,
              message: `PPT 已处理 ${minute} 分钟，仍在生成和校验；如需停止，请点击中止按钮。`,
            });
          }
        }, 15_000)
      : null;
    progressTimer?.unref?.();
    let fileProgressTimer = null;
    let fileProtocolCleanupTimer = null;
    const closeFileProtocol = () => {
      if (fileProtocolCleanupTimer) clearTimeout(fileProtocolCleanupTimer);
      fileProtocolCleanupTimer = null;
      fileProtocol?.close();
    };
    const deferFileProtocolCleanup = () => {
      if (!fileProtocol || fileProtocolCleanupTimer) return;
      fileProtocolCleanupTimer = setTimeout(closeFileProtocol, 15_000);
      fileProtocolCleanupTimer.unref?.();
    };
    const cleanup = () => {
      clearTimeout(renderTimeout);
      if (progressTimer) clearInterval(progressTimer);
      if (fileProgressTimer) clearInterval(fileProgressTimer);
      signal?.removeEventListener?.('abort', handleAbort);
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateRendererProcess(child);
      deferFileProtocolCleanup();
      pptLogger.info('ppt_renderer_cancelled', {
        durationMs: Date.now() - startedAt,
        data: {
          sessionId: payload.session_id || '',
          pythonMode: invocation.packaged ? 'bundled' : 'external',
          lastStage: lastRendererProgressMessage,
        },
      });
      reject(rendererCancelledError());
    };
    signal?.addEventListener?.('abort', handleAbort, { once: true });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    let progressLineBuffer = '';
    const handleProgressLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const event = JSON.parse(trimmed);
        if (event.type === 'progress' && event.message) {
          lastRendererProgressAt = Date.now();
          lastRendererProgressMessage = String(event.message || lastRendererProgressMessage);
          onProgress?.(event);
        }
      } catch {
        // Keep raw stderr for diagnostics.
      }
    };
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      progressLineBuffer += text;
      const lines = progressLineBuffer.split(/\r?\n/);
      progressLineBuffer = lines.pop() || '';
      lines.forEach(handleProgressLine);
    });
    let fileProgressBytes = 0;
    const readFileProtocolProgress = () => {
      if (!fileProtocol) return;
      const { text, bytesRead } = fileProtocol.readProgressFrom(fileProgressBytes);
      fileProgressBytes += bytesRead;
      if (!text) return;
      progressLineBuffer += text;
      const lines = progressLineBuffer.split(/\r?\n/);
      progressLineBuffer = lines.pop() || '';
      lines.forEach(handleProgressLine);
    };
    fileProgressTimer = fileProtocol
      ? setInterval(readFileProtocolProgress, 250)
      : null;
    fileProgressTimer?.unref?.();
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeFileProtocol();
      pptLogger.error('ppt_renderer_spawn_failed', {
        error,
        data: { sessionId: payload.session_id || '', pythonMode: invocation.packaged ? 'bundled' : 'external' },
      });
      reject(error);
    });
    child.on('close', (code) => {
      // A timeout or cancellation settles the promise before the process exits.
      // Keep protocol files alive until this event so Python never loses an
      // output file while it is shutting down.
      if (settled) {
        closeFileProtocol();
        return;
      }
      settled = true;
      cleanup();
      if (fileProtocol) {
        readFileProtocolProgress();
        stdout = fileProtocol.readResult();
        stderr = fileProtocol.readProgress();
        closeFileProtocol();
      }
      if (progressLineBuffer.trim()) handleProgressLine(progressLineBuffer);
      if (code !== 0) {
        const error = new Error(compact(stderr || `PPT renderer exited with code ${code}`, 4000));
        error.code = 'ppt_renderer_process_failed';
        pptLogger.error('ppt_renderer_process_failed', {
          error,
          durationMs: Date.now() - startedAt,
          data: {
            sessionId: payload.session_id || '',
            exitCode: code,
            pythonMode: invocation.packaged ? 'bundled' : 'external',
            selectedStyle: payload.selected_style || 'general',
            selectedTemplate: payload.selected_template || 'none',
            stderrBytes: Buffer.byteLength(stderr),
            stdoutBytes: Buffer.byteLength(stdout),
            lastStage: lastRendererProgressMessage,
          },
        });
        reject(error);
        return;
      }
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'));
      if (!jsonLine) {
        const error = new Error(compact(stderr || stdout || 'PPT renderer returned no JSON output.', 4000));
        error.code = 'ppt_renderer_invalid_output';
        pptLogger.error('ppt_renderer_invalid_output', {
          error,
          durationMs: Date.now() - startedAt,
          data: {
            sessionId: payload.session_id || '',
            pythonMode: invocation.packaged ? 'bundled' : 'external',
            stderrBytes: Buffer.byteLength(stderr),
            stdoutBytes: Buffer.byteLength(stdout),
            lastStage: lastRendererProgressMessage,
          },
        });
        reject(error);
        return;
      }
      pptLogger.info('ppt_renderer_completed', {
        durationMs: Date.now() - startedAt,
        data: {
          sessionId: payload.session_id || '',
          pythonMode: invocation.packaged ? 'bundled' : 'external',
          stderrBytes: Buffer.byteLength(stderr),
          stdoutBytes: Buffer.byteLength(stdout),
          lastStage: lastRendererProgressMessage,
        },
      });
      resolve(jsonLine);
    });
    child.stdin?.on('error', () => {
      // Cancellation can close stdin before the payload is fully written.
    });
    if (!fileProtocol) child.stdin.end(JSON.stringify(payload));
  });
}

function createWindowsRendererProtocol(payload = {}) {
  const directory = path.join(path.resolve(payload.root || '.'), '.janus', 'tmp', 'ppt-renderer-io');
  fs.mkdirSync(directory, { recursive: true });
  const prefix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputPath = path.join(directory, `${prefix}.input.json`);
  const resultPath = path.join(directory, `${prefix}.result.jsonl`);
  const progressPath = path.join(directory, `${prefix}.progress.jsonl`);
  try {
    fs.writeFileSync(inputPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(resultPath, '', { mode: 0o600 });
    fs.writeFileSync(progressPath, '', { mode: 0o600 });
  } catch (error) {
    for (const file of [inputPath, resultPath, progressPath]) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    try { fs.rmdirSync(directory); } catch {}
    throw error;
  }
  let closed = false;
  const read = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  };
  return {
    arguments: [
      '--payload-file', inputPath,
      '--result-file', resultPath,
      '--progress-file', progressPath,
    ],
    readResult: () => read(resultPath),
    readProgress: () => read(progressPath),
    readProgressFrom(offset = 0) {
      let content;
      try { content = fs.readFileSync(progressPath); } catch { return { text: '', bytesRead: 0 }; }
      const chunk = content.subarray(Math.max(0, Number(offset) || 0));
      const completeLineEnd = chunk.lastIndexOf(0x0a);
      if (completeLineEnd < 0) return { text: '', bytesRead: 0 };
      const complete = chunk.subarray(0, completeLineEnd + 1);
      return { text: complete.toString('utf8'), bytesRead: complete.length };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const file of [inputPath, resultPath, progressPath]) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
      try { fs.rmdirSync(directory); } catch {}
    },
  };
}

function absoluteExistingPath(value, label) {
  const file = path.resolve(String(value || ''));
  if (!fs.existsSync(file)) throw new Error(`${label} was not generated: ${file}`);
  return file;
}

function compact(value, limit = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text;
}

export function pptOutputRoot(root) {
  return path.resolve(root);
}
