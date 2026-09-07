import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import ExcelJS from 'exceljs';
import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import { generateImageArtifact, editUploadedImageArtifact } from '../../../imageGeneration.js';
import { imageGenerationProviderState } from '../../../imageProvider.js';
import {
  completeImageGeneration,
  failImageGeneration,
  reserveImageGeneration,
} from '../../../managedProviderUsage.js';
import { inspectOfficeFile } from '../../../officeArtifacts.js';
import { renderPptArtifact } from '../../../pptRenderer.js';
import { pythonEnvironment, resolvePythonInvocation } from '../../../python.js';
import { nowIso, newId } from '../../../utils.js';

const TEXT_FORMATS = new Set(['md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'html', 'htm', 'svg', 'mmd', 'mermaid', 'drawio']);
const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MODERN_BINARY_FORMATS = new Set(['docx', 'xlsx', 'pptx', 'pdf', ...IMAGE_FORMATS]);
const SUPPORTED_FORMATS = new Set([...TEXT_FORMATS, ...MODERN_BINARY_FORMATS]);
const TEXT_PAYLOAD_LIMIT = 2 * 1024 * 1024;
const STRUCTURED_PAYLOAD_LIMIT = 8 * 1024 * 1024;
const IMAGE_FILE_LIMIT = 25 * 1024 * 1024;
const BINARY_FILE_LIMIT = 50 * 1024 * 1024;
const RESERVED_SEGMENTS = new Set(['inputs', '.janus', '.git', 'node_modules']);

export const TASK_ARTIFACT_TOOL_NAME = 'create_task_artifact';

export async function createTaskArtifact({
  runtimeRoot = '',
  store = null,
  task = {},
  node = {},
  agent = {},
  deliverableId = '',
  format = '',
  relativePath = '',
  payload = {},
  expectedSha256 = '',
  signal = null,
  onProgress = null,
  renderPdf = null,
  renderPpt = renderPptArtifact,
  renderImage = null,
} = {}) {
  if (!task?.id || !node?.id || !agent?.id) throw artifactError('artifact_identity_incomplete', 'Task artifact identity is incomplete.');
  const workspaceRoot = String(task.metadata?.workspaceRoot || '').trim();
  if (!workspaceRoot) throw artifactError('workspace_missing', 'Task workspace is missing.');
  const normalizedFormat = normalizeFormat(format);
  if (!SUPPORTED_FORMATS.has(normalizedFormat)) {
    throw artifactError('artifact_format_not_supported', `Unsupported task artifact format: ${normalizedFormat || 'unknown'}.`);
  }
  const target = resolveArtifactTarget(workspaceRoot, relativePath, normalizedFormat);
  const plannedDeliverable = assertPlannedArtifactFormat(task, node, target.extension, deliverableId);
  assertPayloadSize(normalizedFormat, payload);

  const currentTask = store?.getTaskRun?.(task.id) || task;
  const ownership = currentTask.metadata?.taskArtifactReceipts?.[target.relativePath] || null;
  if (ownership && String(ownership.taskNodeId || '') !== String(node.id)) {
    throw artifactError('task_workspace_file_owned_by_other_node', 'Another task node owns this deliverable path.');
  }
  if (ownership?.deliverableId && String(ownership.deliverableId) !== String(plannedDeliverable?.id || deliverableId || '')) {
    throw artifactError('task_workspace_file_owned_by_other_deliverable', 'Another planned deliverable owns this artifact path.');
  }
  const existingSha256 = fileSha256(target.absolutePath);
  const cleanExpectedSha256 = String(expectedSha256 || '').trim().toLowerCase();
  if (cleanExpectedSha256 && cleanExpectedSha256 !== existingSha256) {
    throw artifactError('task_workspace_file_conflict', 'The deliverable changed since the Agent last read it.');
  }
  const inputSha256 = valueSha256({ format: normalizedFormat, payload });
  if (ownership?.inputSha256 === inputSha256 && existingSha256 && ownership.sha256 === existingSha256) {
    return publicReceipt({ ...ownership, status: 'unchanged' });
  }

  onProgress?.({ phase: 'artifact', status: 'running', format: normalizedFormat, relativePath: target.relativePath });
  const stagingRoot = createStagingRoot(target.rootRealPath, node.id);
  let artifactMeta = {};
  try {
    const rendered = await renderArtifact({
      runtimeRoot,
      store,
      task,
      node,
      agent,
      format: normalizedFormat,
      payload,
      stagingRoot,
      workspaceRoot: target.rootRealPath,
      signal,
      onProgress,
      renderPdf,
      renderPpt,
      renderImage,
    });
    const buffer = Buffer.isBuffer(rendered?.buffer)
      ? rendered.buffer
      : rendered?.path ? fs.readFileSync(rendered.path) : null;
    if (!buffer?.length) throw artifactError('artifact_structure_invalid', 'The artifact renderer returned an empty file.');
    assertRenderedSize(normalizedFormat, buffer.length);
    const outputSha256 = bufferSha256(buffer);
    const status = existingSha256 ? (existingSha256 === outputSha256 ? 'unchanged' : 'replaced') : 'created';
    if (status !== 'unchanged') {
      assertArtifactTargetStillSafe(target);
      atomicWriteBuffer(target.absolutePath, buffer);
    }
    validateArtifactFile(target.absolutePath, normalizedFormat);
    artifactMeta = rendered?.meta && typeof rendered.meta === 'object' ? rendered.meta : {};
    const stat = fs.statSync(target.absolutePath);
    const receipt = {
      ok: true,
      taskRunId: task.id,
      taskNodeId: node.id,
      deliverableId: plannedDeliverable?.id || deliverableId || '',
      agentId: agent.id,
      format: normalizedFormat,
      relativePath: target.relativePath,
      path: target.absolutePath,
      bytes: stat.size,
      sha256: fileSha256(target.absolutePath),
      inputSha256,
      validationText: artifactValidationText(payload),
      status,
      createdAt: nowIso(),
      ...artifactMeta,
    };
    persistArtifactReceipt({ store, task, node, agent, receipt });
    onProgress?.({ phase: 'artifact', status: 'completed', format: normalizedFormat, relativePath: target.relativePath, receipt: publicReceipt(receipt) });
    return publicReceipt(receipt);
  } finally {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch {}
  }
}

async function renderArtifact(context = {}) {
  const { format, payload } = context;
  if (TEXT_FORMATS.has(format)) return { buffer: renderText(format, payload) };
  if (format === 'docx') return { buffer: await renderDocx(payload, context.workspaceRoot) };
  if (format === 'xlsx') return { buffer: await renderXlsx(payload) };
  if (format === 'pdf') return { buffer: await renderPdfArtifact(payload, context) };
  if (format === 'pptx') return renderPptxArtifact(payload, context);
  if (IMAGE_FORMATS.has(format)) return renderImageArtifact(payload, context);
  throw artifactError('artifact_format_not_supported', `Unsupported task artifact format: ${format}.`);
}

function renderText(format, payload = {}) {
  const text = String(payload?.text ?? payload?.content ?? '');
  if (!text.trim()) throw artifactError('artifact_payload_invalid', 'Text deliverable content is empty.');
  if (format === 'json') {
    try { JSON.parse(text); } catch { throw artifactError('artifact_payload_invalid', 'JSON deliverable content is invalid.'); }
  }
  return Buffer.from(text, 'utf8');
}

async function renderDocx(payload = {}, workspaceRoot = '') {
  const blocks = normalizeDocumentBlocks(payload);
  const children = [];
  for (const block of blocks) {
    if (block.type === 'page_break') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (block.type === 'heading') {
      const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][Math.max(0, Math.min(3, Number(block.level || 1) - 1))];
      children.push(new Paragraph({ text: String(block.text || ''), heading, spacing: { before: 180, after: 100 } }));
    } else if (block.type === 'list') {
      for (const item of arrayOf(block.items)) {
        children.push(new Paragraph({ text: String(item || ''), bullet: { level: 0 }, spacing: { after: 60 } }));
      }
    } else if (block.type === 'table') {
      const rows = arrayOf(block.rows).map((row) => new TableRow({
        children: arrayOf(row).map((cell) => new TableCell({ children: [new Paragraph(String(cell ?? ''))] })),
      }));
      if (rows.length) children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    } else if (block.type === 'image') {
      const source = resolveExistingWorkspaceFile(workspaceRoot, block.path);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          data: fs.readFileSync(source),
          transformation: { width: Math.max(1, Number(block.width || 600)), height: Math.max(1, Number(block.height || 360)) },
          altText: { title: String(block.alt || ''), description: String(block.alt || ''), name: path.basename(source) },
        })],
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun({ text: String(block.text || ''), bold: Boolean(block.bold), italics: Boolean(block.italics) })],
        spacing: { after: 100, line: 360 },
      }));
    }
  }
  const document = new Document({
    creator: 'Janus',
    title: String(payload.title || ''),
    sections: [{ properties: {}, children }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

async function renderXlsx(payload = {}) {
  const sheets = arrayOf(payload.sheets);
  if (!sheets.length) throw artifactError('artifact_payload_invalid', 'XLSX payload requires at least one worksheet.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Janus';
  for (const [sheetIndex, spec] of sheets.entries()) {
    const worksheet = workbook.addWorksheet(safeWorksheetName(spec?.name || `Sheet ${sheetIndex + 1}`));
    for (const row of arrayOf(spec?.rows)) worksheet.addRow(arrayOf(row).map(safeSpreadsheetValue));
    for (const [index, width] of arrayOf(spec?.column_widths ?? spec?.columnWidths).entries()) {
      if (Number(width) > 0) worksheet.getColumn(index + 1).width = Math.min(120, Number(width));
    }
    const frozenRows = Math.max(0, Math.min(1000, Number(spec?.frozen_rows ?? spec?.frozenRows) || 0));
    if (frozenRows) worksheet.views = [{ state: 'frozen', ySplit: frozenRows }];
    for (const merge of arrayOf(spec?.merges)) {
      if (typeof merge === 'string' && /^[A-Z]+\d+:[A-Z]+\d+$/i.test(merge)) worksheet.mergeCells(merge);
    }
    if (spec?.header_style !== false && worksheet.rowCount > 0) {
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function renderPdfArtifact(payload = {}, context = {}) {
  const blocks = normalizeDocumentBlocks(payload);
  if (typeof context.renderPdf === 'function') {
    const result = await context.renderPdf({ payload: { ...payload, blocks }, ...context });
    return Buffer.isBuffer(result) ? result : Buffer.from(result || '');
  }
  const { BrowserWindow } = await import('electron');
  if (typeof BrowserWindow !== 'function') throw artifactError('artifact_renderer_unavailable', 'Electron PDF renderer is unavailable.');
  const htmlPath = path.join(context.stagingRoot, 'document.html');
  fs.writeFileSync(htmlPath, documentHtml({ ...payload, blocks }, context.workspaceRoot), 'utf8');
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  try {
    await window.loadURL(pathToFileURL(htmlPath).href);
    return Buffer.from(await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }));
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function renderPptxArtifact(payload = {}, context = {}) {
  if (typeof context.renderPpt !== 'function') throw artifactError('artifact_renderer_unavailable', 'PPTX renderer is unavailable.');
  const slides = arrayOf(payload.slides);
  if (!slides.length) throw artifactError('artifact_payload_invalid', 'PPTX payload requires at least one slide.');
  const answer = presentationAssistantAnswer(payload, slides);
  const result = await context.renderPpt({
    root: context.runtimeRoot,
    store: context.store,
    accountWorkspaceId: context.task.accountWorkspaceId
      || context.task.workspaceId
      || context.task.metadata?.accountWorkspaceId
      || context.task.metadata?.workspaceId
      || 'workspace_personal',
    quotaEventPrefix: `${context.task.id}:${context.node.id}`,
    outputRoot: context.stagingRoot,
    artifactRoot: context.workspaceRoot,
    userId: context.task.ownerUserId || context.task.metadata?.userId || 'desktop',
    sessionId: `${context.task.id}-${context.node.id}-artifact`,
    agentId: context.agent.id,
    userMessage: String(payload.user_message || payload.title || 'Create an editable presentation.'),
    assistantAnswer: answer,
    selectedStyle: String(payload.style_id || 'general'),
    selectedTemplate: String(payload.template_id || 'none'),
    sourceImagePaths: arrayOf(payload.source_image_paths).map((item) => resolveExistingWorkspaceFile(context.workspaceRoot, item)),
    signal: context.signal,
    onProgress: context.onProgress,
  });
  return {
    path: result.deck,
    meta: { slideCount: Number(result.slide_count || slides.length), preview: result.preview || null },
  };
}

async function renderImageArtifact(payload = {}, context = {}) {
  if (typeof context.renderImage === 'function') return context.renderImage({ payload, ...context });
  const prompt = String(payload.prompt || '').trim();
  if (!prompt) throw artifactError('artifact_payload_invalid', 'Image payload requires a prompt.');
  const sources = arrayOf(payload.source_image_paths).map((item) => {
    const sourcePath = resolveExistingWorkspaceFile(context.workspaceRoot, item);
    return { path: sourcePath, mediaType: imageMediaType(sourcePath) };
  });
  const eventKey = `task-artifact-image:${context.task.id}:${context.node.id}:${valueSha256(payload).slice(0, 16)}`;
  const providerState = imageGenerationProviderState(context.runtimeRoot);
  let reserved = false;
  try {
    reserveImageGeneration(context.store, {
      userId: context.task.ownerUserId || context.task.metadata?.userId || 'desktop',
      accountWorkspaceId: context.task.accountWorkspaceId
        || context.task.workspaceId
        || context.task.metadata?.accountWorkspaceId
        || context.task.metadata?.workspaceId
        || 'workspace_personal',
      executionId: `${context.task.id}:${context.node.id}`,
      sessionId: `${context.task.id}-${context.node.id}`,
      eventKey,
      agentId: context.agent.id,
      model: String(payload.model || process.env.JANUS_IMAGE_MODEL || 'gpt-image-2'),
      providerState,
    });
    reserved = true;
    const options = {
      root: context.runtimeRoot,
      outputRoot: context.stagingRoot,
      artifactRoot: context.workspaceRoot,
      sessionId: `${context.task.id}-${context.node.id}`,
      prompt,
      model: String(payload.model || process.env.JANUS_IMAGE_MODEL || 'gpt-image-2'),
      quality: String(payload.quality || 'auto'),
      signal: context.signal,
    };
    const artifact = sources.length
      ? await editUploadedImageArtifact({ ...options, sources })
      : await generateImageArtifact({ ...options, size: String(payload.size || '1024x1024') });
    completeImageGeneration(context.store, eventKey, {
      userId: context.task.ownerUserId || context.task.metadata?.userId || 'desktop',
      providerState,
    });
    reserved = false;
    const converted = convertImageIfNeeded(artifact.path, context.format, context.stagingRoot, context.runtimeRoot);
    return { path: converted, meta: { preview: artifact.preview || null, model: artifact.model || options.model } };
  } catch (error) {
    if (reserved) failImageGeneration(context.store, eventKey, {
      userId: context.task.ownerUserId || context.task.metadata?.userId || 'desktop',
      providerState,
    });
    throw error;
  }
}

function persistArtifactReceipt({ store, task, node, agent, receipt }) {
  if (!store?.updateTaskRunMetadata) return;
  const current = store.getTaskRun(task.id) || task;
  const previousFiles = arrayOf(current.metadata?.generatedTaskFiles);
  const file = {
    name: path.basename(receipt.path),
    filename: path.basename(receipt.path),
    path: receipt.path,
    source_path: receipt.path,
    relative_path: receipt.relativePath,
    workspace_relative_path: receipt.relativePath,
    size: receipt.bytes,
    sha256: receipt.sha256,
    kind: receipt.format,
    format: receipt.format,
    generated_for_task: task.id,
    task_node_id: node.id,
    deliverable_id: receipt.deliverableId || '',
  };
  const generatedTaskFiles = [
    ...previousFiles.filter((item) => String(item.workspace_relative_path || item.relative_path || '') !== receipt.relativePath),
    file,
  ].slice(-40);
  store.updateTaskRunMetadata(task.id, {
    generatedTaskFiles,
    taskArtifactReceipts: {
      ...(current.metadata?.taskArtifactReceipts || {}),
      [receipt.relativePath]: receipt,
    },
  });
  store.recordTaskEvent?.({
    taskRunId: task.id,
    taskNodeId: node.id,
    eventType: 'task_artifact_created',
    actorId: agent.id,
    summary: `${node.title || node.id}: ${receipt.relativePath} ${receipt.status}.`,
    payload: publicReceipt(receipt),
  });
}

function resolveArtifactTarget(workspaceRoot = '', relativePath = '', format = '') {
  const raw = String(relativePath || '').trim();
  if (!raw || raw.includes('\0') || path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || /^\/\//.test(raw)) {
    throw artifactError('invalid_task_workspace_path', 'Artifact path must be workspace-relative.');
  }
  const normalized = raw.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw artifactError('task_workspace_path_escape', 'Artifact path cannot contain empty, dot, or parent segments.');
  }
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (segment.startsWith('.') || RESERVED_SEGMENTS.has(lower) || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || windowsReservedName(segment)) {
      throw artifactError('invalid_task_workspace_path', `Artifact path contains a reserved segment: ${segment}.`);
    }
  }
  const extension = path.extname(normalized).toLowerCase();
  if (extension !== `.${format}` && !(format === 'markdown' && extension === '.md') && !(format === 'md' && extension === '.markdown')) {
    throw artifactError('artifact_format_not_planned', `Artifact extension ${extension || '(none)'} does not match format ${format}.`);
  }
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const rootRealPath = fs.realpathSync(workspaceRoot);
  ensureSafeParentDirectories(rootRealPath, segments.slice(0, -1));
  const absolutePath = path.resolve(rootRealPath, ...segments);
  if (pathOutsideRoot(rootRealPath, absolutePath)) throw artifactError('task_workspace_path_escape', 'Artifact path escapes the task workspace.');
  if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isSymbolicLink()) {
    throw artifactError('task_workspace_symlink_escape', 'Artifact target cannot be a symbolic link.');
  }
  return { rootRealPath, absolutePath, relativePath: segments.join('/'), extension };
}

function ensureSafeParentDirectories(rootRealPath, segments = []) {
  let current = rootRealPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw artifactError('task_workspace_symlink_escape', 'Artifact parent cannot be a symbolic link.');
      if (!stat.isDirectory()) throw artifactError('invalid_task_workspace_path', 'Artifact parent is not a directory.');
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const real = fs.realpathSync(current);
    if (pathOutsideRoot(rootRealPath, real)) throw artifactError('task_workspace_symlink_escape', 'Artifact parent escapes the task workspace.');
  }
}

function assertArtifactTargetStillSafe(target = {}) {
  const segments = String(target.relativePath || '').split('/');
  let current = target.rootRealPath;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw artifactError('task_workspace_symlink_escape', 'Artifact parent changed during rendering.');
    }
    if (pathOutsideRoot(target.rootRealPath, fs.realpathSync(current))) {
      throw artifactError('task_workspace_symlink_escape', 'Artifact parent escaped the task workspace during rendering.');
    }
  }
  if (path.resolve(target.rootRealPath, ...segments) !== target.absolutePath) {
    throw artifactError('task_workspace_path_escape', 'Artifact target changed during rendering.');
  }
  if (fs.existsSync(target.absolutePath) && fs.lstatSync(target.absolutePath).isSymbolicLink()) {
    throw artifactError('task_workspace_symlink_escape', 'Artifact target changed to a symbolic link during rendering.');
  }
}

function assertPlannedArtifactFormat(task = {}, node = {}, extension = '', deliverableId = '') {
  const contract = task.metadata?.deliverableContract || {};
  if (contract.requested_output_type === 'code_change') {
    throw artifactError('artifact_format_not_planned', 'The task artifact writer cannot modify source-code deliverables.');
  }
  const matching = arrayOf(contract.deliverables).filter((item) => {
    const ownerNodeId = String(item.owner_node_id || item.ownerNodeId || '');
    if (ownerNodeId && ![node.id, node.localId].includes(ownerNodeId)) return false;
    if (deliverableId && String(item.id || '') !== String(deliverableId)) return false;
    return arrayOf(item.required_extensions || item.requiredExtensions).map(normalizeExtension).includes(extension);
  });
  if (matching.length) {
    if (matching.length !== 1) throw artifactError('artifact_format_not_planned', 'Multiple deliverables accept this format; deliverable_id is required.');
    return matching[0];
  }
  const planned = new Set(arrayOf(contract.required_extensions).map(normalizeExtension));
  if (planned.size && !planned.has(extension)) {
    throw artifactError('artifact_format_not_planned', `The delivery contract does not allow ${extension}.`);
  }
  if (arrayOf(contract.deliverables).length) {
    throw artifactError('artifact_format_not_planned', `No deliverable owned by this task node allows ${extension}.`);
  }
  return { id: deliverableId || contract.id || 'primary' };
}

function assertPayloadSize(format, payload) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(payload ?? {}), 'utf8'); } catch { throw artifactError('artifact_payload_invalid', 'Artifact payload is not serializable.'); }
  const limit = TEXT_FORMATS.has(format) ? TEXT_PAYLOAD_LIMIT : STRUCTURED_PAYLOAD_LIMIT;
  if (bytes <= 0 || bytes > limit) throw artifactError('artifact_too_large', `Artifact payload exceeds ${Math.round(limit / 1024 / 1024)} MiB.`);
}

function assertRenderedSize(format, bytes) {
  const limit = IMAGE_FORMATS.has(format) ? IMAGE_FILE_LIMIT : TEXT_FORMATS.has(format) ? TEXT_PAYLOAD_LIMIT : BINARY_FILE_LIMIT;
  if (bytes <= 0 || bytes > limit) throw artifactError('artifact_too_large', `Rendered artifact exceeds ${Math.round(limit / 1024 / 1024)} MiB.`);
}

function atomicWriteBuffer(target, buffer) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temp, target);
  } catch (error) {
    if (descriptor !== null && descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function validateArtifactFile(file, format) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw artifactError('artifact_structure_invalid', 'Generated artifact is empty.');
  if (['docx', 'xlsx', 'pptx'].includes(format)) {
    const result = inspectOfficeFile(file, `.${format}`);
    if (!result.valid) throw artifactError('artifact_structure_invalid', result.message || 'Generated Office artifact is invalid.');
    return;
  }
  const head = readFilePart(file, 0, Math.min(stat.size, 16));
  const tailLength = format === 'pdf' ? Math.min(stat.size, 4096) : Math.min(stat.size, 16);
  const tail = readFilePart(file, Math.max(0, stat.size - tailLength), tailLength);
  if (format === 'pdf' && (!head.toString('ascii').startsWith('%PDF-') || !tail.toString('ascii').includes('%%EOF'))) {
    throw artifactError('artifact_structure_invalid', 'Generated PDF is invalid.');
  }
  if (format === 'png') {
    const pngEnd = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    if (!head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || !tail.subarray(-pngEnd.length).equals(pngEnd)) {
      throw artifactError('artifact_structure_invalid', 'Generated PNG is invalid.');
    }
  }
  if (['jpg', 'jpeg'].includes(format) && (!head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || !tail.subarray(-2).equals(Buffer.from([0xff, 0xd9])))) {
    throw artifactError('artifact_structure_invalid', 'Generated JPEG is invalid.');
  }
  if (format === 'webp') {
    const declaredSize = head.length >= 8 ? head.readUInt32LE(4) + 8 : 0;
    if (!(head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP' && declaredSize <= stat.size)) {
      throw artifactError('artifact_structure_invalid', 'Generated WebP is invalid.');
    }
  }
  if (TEXT_FORMATS.has(format) && readFilePart(file, 0, Math.min(stat.size, 64 * 1024)).includes(0x00)) {
    throw artifactError('artifact_structure_invalid', 'Generated text artifact contains binary data.');
  }
}

function normalizeDocumentBlocks(payload = {}) {
  const blocks = arrayOf(payload.blocks).filter((item) => item && typeof item === 'object');
  if (!blocks.length) throw artifactError('artifact_payload_invalid', 'Document payload requires non-empty blocks.');
  if (!blocks.some((item) => String(item.text || '').trim() || arrayOf(item.items).length || arrayOf(item.rows).length || item.path)) {
    throw artifactError('artifact_payload_invalid', 'Document blocks are empty.');
  }
  return blocks;
}

function documentHtml(payload = {}, workspaceRoot = '') {
  const body = arrayOf(payload.blocks).map((block) => {
    if (block.type === 'heading') {
      const level = Math.max(1, Math.min(4, Number(block.level || 1)));
      return `<h${level}>${escapeHtml(block.text)}</h${level}>`;
    }
    if (block.type === 'list') return `<ul>${arrayOf(block.items).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    if (block.type === 'table') return `<table>${arrayOf(block.rows).map((row) => `<tr>${arrayOf(row).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
    if (block.type === 'image') {
      const source = resolveExistingWorkspaceFile(workspaceRoot, block.path);
      const dataUrl = `data:${imageMediaType(source)};base64,${fs.readFileSync(source).toString('base64')}`;
      return `<figure><img src="${dataUrl}" alt="${escapeHtml(block.alt || '')}">${block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : ''}</figure>`;
    }
    if (block.type === 'page_break') return '<div class="page-break"></div>';
    return `<p>${escapeHtml(block.text)}</p>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>@page{size:A4;margin:18mm}body{font-family:Arial,'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#111;font-size:11pt;line-height:1.65}h1{font-size:22pt}h2{font-size:17pt}h3{font-size:14pt}table{width:100%;border-collapse:collapse;margin:12px 0}td{border:1px solid #999;padding:5px 7px}figure{margin:12px 0;text-align:center}img{max-width:100%;max-height:230mm}figcaption{font-size:9pt;color:#555}.page-break{break-after:page}</style></head><body><h1>${escapeHtml(payload.title || '')}</h1>${body}</body></html>`;
}

function presentationAssistantAnswer(payload, slides) {
  const rows = slides.map((slide) => [
    slide.layout_id || 'basic_content', slide.title || '', slide.message || '', slide.proof_object || '', slide.visual || '', slide.speaker_note || '', slide.time || '',
  ].map(markdownTableCell).join(' | '));
  const deck = {
    schema_version: 'janus-multifunction-v1',
    title: String(payload.title || ''),
    slides: slides.map((slide) => ({
      layout_id: String(slide.layout_id || 'basic_content'),
      content_spec: { title: String(slide.title || ''), ...(slide.content_spec || {}) },
    })),
  };
  return [
    String(payload.title || 'Presentation'),
    '```janus-slide-plan',
    '| layout_id | title | message | proof_object | visual | speaker_note | time |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '```',
    '```janus-deck-spec',
    JSON.stringify(deck),
    '```',
  ].join('\n');
}

function convertImageIfNeeded(source, format, stagingRoot, runtimeRoot) {
  if (format === 'png') return source;
  const target = path.join(stagingRoot, `converted.${format === 'jpeg' ? 'jpg' : format}`);
  const script = [
    'from PIL import Image',
    'import sys',
    'source, target, fmt = sys.argv[1:4]',
    'image = Image.open(source)',
    "image = image.convert('RGB') if fmt in ('JPEG', 'WEBP') else image",
    'image.save(target, format=fmt, quality=92)',
  ].join('\n');
  const invocation = resolvePythonInvocation(['-c', script, source, target, ['jpg', 'jpeg'].includes(format) ? 'JPEG' : 'WEBP'], { required: true, root: runtimeRoot });
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: pythonEnvironment({}, { root: runtimeRoot }) });
  if (result.error || result.status !== 0 || !fs.existsSync(target)) throw artifactError('artifact_renderer_unavailable', 'Image format conversion failed.');
  return target;
}

function resolveExistingWorkspaceFile(workspaceRoot, relativePath) {
  const raw = String(relativePath || '').trim().replace(/\\/g, '/');
  if (!raw || path.isAbsolute(raw) || raw.split('/').some((segment) => segment === '..')) throw artifactError('invalid_task_workspace_path', 'Referenced source must be workspace-relative.');
  const root = fs.realpathSync(workspaceRoot);
  const candidate = path.resolve(root, raw);
  if (!fs.existsSync(candidate)) throw artifactError('required_input_missing', `Referenced workspace file does not exist: ${raw}.`);
  const real = fs.realpathSync(candidate);
  if (pathOutsideRoot(root, real) || !fs.statSync(real).isFile()) throw artifactError('task_workspace_symlink_escape', 'Referenced source escapes the task workspace.');
  return real;
}

function safeSpreadsheetValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? '';
  if (typeof value.formula === 'string') {
    const formula = value.formula.trim().replace(/^=/, '');
    if (!formula || /(?:\[[^\]]+\]|https?:|file:|\\\\|WEBSERVICE\s*\(|DDE\s*\()/i.test(formula)) {
      throw artifactError('artifact_payload_invalid', 'External or unsafe spreadsheet formulas are not allowed.');
    }
    return { formula, result: value.result ?? null };
  }
  if (value.hyperlink) throw artifactError('artifact_payload_invalid', 'External spreadsheet hyperlinks are not allowed.');
  return value.value ?? '';
}

function safeWorksheetName(value) {
  const clean = String(value || 'Sheet').replace(/[\\/*?:[\]]/g, '-').trim().slice(0, 31);
  return clean || 'Sheet';
}

function normalizeFormat(value) {
  return String(value || '').trim().toLowerCase().replace(/^\./, '');
}

function normalizeExtension(value) {
  const clean = String(value || '').trim().toLowerCase();
  return clean ? (clean.startsWith('.') ? clean : `.${clean}`) : '';
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function windowsReservedName(segment) {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
}

function pathOutsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function createStagingRoot(workspaceRoot, nodeId) {
  const base = path.join(workspaceRoot, '.janus-artifacts');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const target = path.join(base, `${String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}-${newId('render')}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

function fileSha256(file) {
  try { return bufferSha256(fs.readFileSync(file)); } catch { return ''; }
}

function bufferSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function valueSha256(value) {
  return bufferSha256(Buffer.from(stableJson(value), 'utf8'));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function readFilePart(file, position, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function imageMediaType(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file).toLowerCase()]
    || (() => { throw artifactError('artifact_payload_invalid', 'Image sources must be PNG, JPEG, or WebP.'); })();
}

function markdownTableCell(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function publicReceipt(receipt = {}) {
  return {
    ok: receipt.ok !== false,
    deliverableId: String(receipt.deliverableId || receipt.deliverable_id || ''),
    relativePath: receipt.relativePath,
    format: receipt.format,
    bytes: Number(receipt.bytes || 0),
    sha256: receipt.sha256,
    status: receipt.status,
    ...(Number(receipt.slideCount || 0) ? { slideCount: Number(receipt.slideCount) } : {}),
    ...(receipt.preview ? { preview: receipt.preview } : {}),
  };
}

function artifactValidationText(payload = {}) {
  const parts = [payload.title];
  for (const block of arrayOf(payload.blocks)) {
    parts.push(block?.text, ...arrayOf(block?.items));
    for (const row of arrayOf(block?.rows)) parts.push(...arrayOf(row));
  }
  for (const sheet of arrayOf(payload.sheets)) {
    parts.push(sheet?.name);
    for (const row of arrayOf(sheet?.rows)) parts.push(...arrayOf(row).map((cell) => (
      cell && typeof cell === 'object' ? cell.value ?? cell.formula ?? '' : cell
    )));
  }
  for (const slide of arrayOf(payload.slides)) {
    parts.push(slide?.title, slide?.message, slide?.proof_object, slide?.speaker_note);
  }
  return parts.map((item) => String(item ?? '').trim()).filter(Boolean).join('\n').slice(0, 256 * 1024);
}

function artifactError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
