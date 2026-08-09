import fs from 'node:fs';
import path from 'node:path';

import { createHttpClient } from '../core/httpClient.js';

export class OpenAIImagesClient {
  constructor({
    apiKey = '',
    apiBase = 'https://api.openai.com/v1',
    fetchImpl = globalThis.fetch,
    timeoutMs = 300_000,
    downloadTimeoutMs = 60_000,
  } = {}) {
    this.apiKey = apiKey;
    this.apiBase = normalizeOpenAiApiBase(apiBase);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1_000, Number(timeoutMs || 300_000));
    this.downloadTimeoutMs = Math.max(1_000, Number(downloadTimeoutMs || 60_000));
    this.http = createHttpClient({ fetchImpl, timeoutMs: this.downloadTimeoutMs });
  }

  async generateImage(payload, { signal = null } = {}) {
    return this.jsonRequest('/images/generations', payload, '图片生成', { signal });
  }

  async editImages(fields, sources = [], { signal = null } = {}) {
    const response = await this.multipartRequest('/images/edits', fields, sources, false, { signal });
    if (!response.ok && sources.length > 1) {
      return parseOpenAiJsonResponse(
        await this.multipartRequest('/images/edits', fields, sources, true, { signal }),
        '图片编辑',
      );
    }
    return parseOpenAiJsonResponse(response, '图片编辑');
  }

  async imageBytesFromResponse(response, actionLabel) {
    const first = Array.isArray(response?.data) ? response.data[0] : null;
    if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
    if (first?.url) {
      const raw = await this.http.request(first.url, {
        method: 'GET',
        responseType: 'arrayBuffer',
        errorMessage: `${actionLabel}已完成，但图片下载失败。`,
      });
      return Buffer.from(raw);
    }
    throw new Error(`${actionLabel}服务没有返回图片。`);
  }

  async jsonRequest(endpoint, payload, actionLabel, { signal = null } = {}) {
    if (!this.apiKey) throw new Error('未配置图片生成 API Key；请配置 OPENAI_IMAGE_API_KEY，或使用支持 Images API 的 OPENAI_API_KEY。');
    const response = await this.fetchWithTimeout(`${this.apiBase}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
    return parseOpenAiJsonResponse(response, actionLabel);
  }

  multipartRequest(endpoint, fields, sources, useArrayField, { signal = null } = {}) {
    if (!this.apiKey) throw new Error('未配置图片生成 API Key；请配置 OPENAI_IMAGE_API_KEY，或使用支持 Images API 的 OPENAI_API_KEY。');
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    for (const source of sources) {
      const data = fs.readFileSync(source.path);
      form.append(useArrayField ? 'image[]' : 'image', new Blob([data], { type: source.mediaType }), path.basename(source.path));
    }
    return this.fetchWithTimeout(`${this.apiBase}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal,
    });
  }

  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const externalSignal = options.signal || null;
    let timedOut = false;
    const abortFromExternal = () => controller.abort(externalSignal?.reason || new Error('Image request cancelled.'));
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Image request timed out after ${this.timeoutMs}ms.`));
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new Error(`图片生成处理超过 ${Math.ceil(this.timeoutMs / 1000)} 秒；请求已停止，可重试或通过 JANUS_IMAGE_REQUEST_TIMEOUT_MS 调整等待时间。`);
      }
      if (externalSignal?.aborted) throw externalSignal.reason || error;
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  }
}

export function normalizeOpenAiApiBase(value) {
  const base = String(value || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

async function parseOpenAiJsonResponse(response, actionLabel) {
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    throw new Error(`${actionLabel}服务返回了无法识别的结果。`);
  }
  if (!response.ok) {
    throw new Error(parsed?.error?.message || parsed?.message || `${actionLabel}失败：HTTP ${response.status}`);
  }
  return parsed;
}
