import { NetworkRequestError, responseDetail } from './errors.js';

export function createHttpClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = 0,
  defaultHeaders = {},
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.');
  }

  async function request(url, {
    method = 'GET',
    route = '',
    headers = {},
    body = undefined,
    responseType = 'json',
    errorMessage = null,
    timeoutMs: requestTimeoutMs = timeoutMs,
  } = {}) {
    const effectiveTimeoutMs = Math.max(0, Number(requestTimeoutMs || 0));
    const controller = effectiveTimeoutMs > 0 ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(new Error(`Request timed out after ${effectiveTimeoutMs}ms.`)), effectiveTimeoutMs)
      : null;
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...defaultHeaders,
          ...testCorrelationHeaders(),
          ...headers,
        },
        body,
        signal: controller?.signal,
      });
      return parseResponse(response, { method, url, route, responseType, errorMessage });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return { request };
}

export async function parseResponse(response, {
  method = 'GET',
  url = '',
  route = '',
  responseType = 'json',
  errorMessage = null,
} = {}) {
  if (responseType === 'response') {
    if (response.ok) return response;
    const text = await response.text();
    const parsed = safeJsonParse(text, null);
    const detail = responseDetail({ parsed, text, fallback: response.statusText });
    throw new NetworkRequestError(errorMessage ? errorMessage({ response, detail, text, parsed }) : `Request failed (${response.status}): ${detail}`, {
      status: response.status,
      method,
      url,
      route,
      body: parsed || text,
      code: parsed?.error?.code || parsed?.code || '',
      details: parsed?.error?.details || parsed?.details || null,
      requestId: response.headers?.get?.('x-request-id') || '',
    });
  }
  if (responseType === 'arrayBuffer') {
    if (!response.ok) {
      throw new NetworkRequestError(errorMessage || `Request failed (${response.status}).`, {
        status: response.status,
        method,
        url,
        route,
        requestId: response.headers?.get?.('x-request-id') || '',
      });
    }
    return response.arrayBuffer();
  }

  const text = await response.text();
  const parsed = responseType === 'text' ? null : safeJsonParse(text, null);
  if (!response.ok) {
    const detail = responseDetail({ parsed, text, fallback: response.statusText });
    throw new NetworkRequestError(errorMessage ? errorMessage({ response, detail, text, parsed }) : `Request failed (${response.status}): ${detail}`, {
      status: response.status,
      method,
      url,
      route,
      body: parsed || text,
      code: parsed?.error?.code || parsed?.code || '',
      details: parsed?.error?.details || parsed?.details || null,
      requestId: response.headers?.get?.('x-request-id') || '',
    });
  }
  if (responseType === 'text') return text;
  return parsed || {};
}

function safeJsonParse(text, fallback) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return fallback;
  }
}

function testCorrelationHeaders() {
  const env = globalThis.process?.env || {};
  if (String(env.JANUS_TEST_DIAGNOSTICS || '') !== '1') return {};
  const runId = cleanCorrelationId(env.JANUS_TEST_RUN_ID);
  const caseId = cleanCorrelationId(env.JANUS_TEST_CASE_ID);
  return {
    ...(runId ? { 'x-janus-test-run-id': runId } : {}),
    ...(caseId ? { 'x-janus-test-case-id': caseId } : {}),
  };
}

function cleanCorrelationId(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160);
}
