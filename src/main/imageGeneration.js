import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { artifactFileInfo } from './artifacts.js';
import { ensureDirSync, newId } from './utils.js';
import { imageGenerationProviderState } from './imageProvider.js';
import { OpenAIImagesClient } from '../../network/clients/openaiImagesClient.js';

const DEFAULT_IMAGE_MODEL = process.env.JANUS_IMAGE_MODEL || 'gpt-image-2';
const IMAGE_EDIT_SUPPORTED = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

export async function generateImageArtifact({ root, outputRoot = root, artifactRoot = outputRoot, sessionId, prompt, model = DEFAULT_IMAGE_MODEL, quality = 'auto', size = '1024x1024', signal = null }) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('请输入图片生成描述。');
  const payload = {
    model: model || DEFAULT_IMAGE_MODEL,
    prompt: cleanPrompt,
    size: size || '1024x1024',
    n: 1,
  };
  if (quality && quality !== 'auto') payload.quality = quality;
  const client = openaiImagesClient(root);
  const response = await client.generateImage(payload, { signal });
  const raw = await client.imageBytesFromResponse(response, '图片生成', { signal });
  throwIfImageRequestCancelled(signal);
  return saveImageArtifact({
    root: artifactRoot,
    outputRoot,
    sessionId,
    prompt: cleanPrompt,
    raw,
    model: payload.model,
    quality,
    prefix: 'generated',
    providerUsage: imageProviderUsage(response),
    imageCount: Array.isArray(response?.data) ? Math.max(1, response.data.length) : 1,
  });
}

export async function editImageArtifact({ root, outputRoot = root, artifactRoot = outputRoot, sessionId, prompt, sourceArtifact, model = DEFAULT_IMAGE_MODEL, quality = 'auto', signal = null }) {
  const sourcePath = artifactPathFromInfo(sourceArtifact);
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('没有找到可引用的上一张图片。');
  const mediaType = supportedImageMediaType(sourcePath);
  const artifact = await editUploadedImageArtifact({
    root,
    outputRoot,
    artifactRoot,
    sessionId,
    prompt,
    sources: [{ path: sourcePath, mediaType }],
    model,
    quality,
    signal,
  });
  artifact.source_image = sourceArtifact?.name || path.basename(sourcePath);
  artifact.preview.title = '修改图片';
  return artifact;
}

export async function editUploadedImageArtifact({ root, outputRoot = root, artifactRoot = outputRoot, sessionId, prompt, sources = [], model = DEFAULT_IMAGE_MODEL, quality = 'auto', signal = null }) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('请输入图片编辑描述。');
  if (!sources.length) throw new Error('图像编辑需要至少一张参考图片。');
  const fields = {
    model: model || DEFAULT_IMAGE_MODEL,
    prompt: cleanPrompt,
    size: '1024x1024',
    n: '1',
  };
  if (quality && quality !== 'auto') fields.quality = quality;
  const client = openaiImagesClient(root);
  const response = await client.editImages(fields, sources, { signal });
  const raw = await client.imageBytesFromResponse(response, '图片编辑', { signal });
  throwIfImageRequestCancelled(signal);
  const artifact = saveImageArtifact({
    root: artifactRoot,
    outputRoot,
    sessionId,
    prompt: cleanPrompt,
    raw,
    model: fields.model,
    quality,
    prefix: 'edited',
    providerUsage: imageProviderUsage(response),
    imageCount: Array.isArray(response?.data) ? Math.max(1, response.data.length) : 1,
  });
  artifact.source_images = sources.map((item) => path.basename(item.path));
  artifact.preview.title = '修改图片';
  return artifact;
}

function throwIfImageRequestCancelled(signal = null) {
  if (!signal?.aborted) return;
  throw signal.reason || new Error('Image request cancelled.');
}

export function shouldEditPreviousImage(message) {
  return /(刚才|上一张|上张|这张|这幅|这个图|那张|它|基于|参考|沿用|保留|改成|修改|调整|重绘|换成|变成|加上|去掉|移除|替换|风格|颜色|背景|构图|姿势|表情)/.test(String(message || ''));
}

export function imageEditSourcesFromAttachments(attachments = []) {
  return attachments.map((attachment) => ({
    path: attachment.path,
    mediaType: supportedImageMediaType(attachment.path, attachment.type || attachment.content_type),
  }));
}

function saveImageArtifact({ root, outputRoot = root, sessionId, prompt, raw, model, quality, prefix, providerUsage = {}, imageCount = 1 }) {
  const digest = newId('img').split('_').pop().slice(0, 8);
  const slug = imageFilenameSlug(prompt, digest);
  const filename = prefix === 'generated' ? `${slug}-${digest}.png` : `${slug}-edit-${digest}.png`;
  ensureDirSync(outputRoot);
  const target = uniqueFilePath(path.join(outputRoot, filename));
  fs.writeFileSync(target, raw);
  return {
    kind: 'image',
    ...artifactFileInfo(root, target, {
      name: path.basename(target),
      model: model || DEFAULT_IMAGE_MODEL,
      quality: quality || 'auto',
      url: pathToFileURL(target).href,
      render_url: pathToFileURL(target).href,
      preview: {
        kind: 'image',
        title: prefix === 'generated' ? '生成图片' : '修改图片',
        subtitle: compactPreviewText(prompt, 180),
      },
      provider_usage: providerUsage,
      image_count: Math.max(1, Number(imageCount) || 1),
    }),
  };
}

function imageProviderUsage(response = {}) {
  const usage = response?.usage && typeof response.usage === 'object' ? response.usage : {};
  const billing = response?.billing && typeof response.billing === 'object' ? response.billing : {};
  const costUsd = response?.cost_usd ?? response?.costUsd ?? usage?.cost_usd ?? usage?.costUsd ?? billing?.cost_usd ?? billing?.amount_usd;
  return {
    ...usage,
    ...(Object.keys(billing).length ? { billing } : {}),
    ...(Number.isFinite(Number(costUsd)) && Number(costUsd) > 0 ? { cost_usd: Number(costUsd) } : {}),
  };
}

function uniqueFilePath(candidate) {
  if (!fs.existsSync(candidate)) return candidate;
  const extension = path.extname(candidate);
  const stem = candidate.slice(0, -extension.length);
  for (let index = 2; index < 10_000; index += 1) {
    const next = `${stem}-${index}${extension}`;
    if (!fs.existsSync(next)) return next;
  }
  throw new Error(`无法为图片生成唯一文件名：${path.basename(candidate)}`);
}

function openaiImagesClient(root) {
  const provider = imageGenerationProviderState(root);
  return new OpenAIImagesClient({
    apiKey: provider.apiKey,
    apiBase: provider.baseUrl,
    timeoutMs: Number(process.env.JANUS_IMAGE_REQUEST_TIMEOUT_MS || 600_000),
    downloadTimeoutMs: Number(process.env.JANUS_IMAGE_DOWNLOAD_TIMEOUT_MS || 60_000),
  });
}

function supportedImageMediaType(file, contentType = '') {
  const ext = path.extname(file).toLowerCase();
  const mediaType = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  const normalized = mediaType === 'image/jpg' ? 'image/jpeg' : mediaType;
  if (IMAGE_EDIT_SUPPORTED.has(ext) && (!normalized || [...IMAGE_EDIT_SUPPORTED.values()].includes(normalized))) {
    return normalized || IMAGE_EDIT_SUPPORTED.get(ext);
  }
  throw new Error('图像编辑仅支持上传 PNG、JPG、JPEG、WEBP 文件。');
}

function artifactPathFromInfo(info) {
  if (info?.path) return info.path;
  const url = info?.download_url || info?.url || info?.file_url || '';
  if (String(url).startsWith('file:')) {
    try {
      return fileURLToPath(url);
    } catch {
      return '';
    }
  }
  return '';
}

function imageFilenameSlug(prompt, fallbackDigest) {
  const keywords = [
    ['海报', 'poster'], ['实验室', 'lab'], ['城市', 'city'], ['宇宙', 'space'], ['星空', 'stars'],
    ['机器人', 'robot'], ['写实', 'realistic'], ['卡通', 'cartoon'], ['电影', 'cinematic'], ['背景', 'background'],
  ];
  const text = String(prompt || '').toLowerCase();
  const tokens = [];
  for (const [keyword, token] of keywords) {
    if (text.includes(keyword) && !tokens.includes(token)) tokens.push(token);
  }
  for (const word of text.match(/[a-z0-9]+/g) || []) {
    if (['generate', 'image', 'picture', 'photo', 'make', 'create', 'png', 'jpg'].includes(word)) continue;
    if (!tokens.includes(word)) tokens.push(word);
    if (tokens.length >= 6) break;
  }
  return (tokens.length ? tokens.join('-') : `image-${fallbackDigest}`).replace(/-+/g, '-').slice(0, 72);
}

function compactPreviewText(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}...` : clean;
}
