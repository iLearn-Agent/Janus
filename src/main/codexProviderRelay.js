import http from 'node:http';

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024;
// A model response may legitimately take a while, but a dead Electron fetch
// must never leave Codex waiting forever. This is an idle timeout: every
// upstream chunk resets it, so normal streaming responses are unaffected.
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000;

export async function createCodexProviderRelay({ electronSession, getBaseUrl } = {}) {
  if (!electronSession?.fetch) throw new Error('Electron network session is unavailable.');
  if (typeof getBaseUrl !== 'function') throw new Error('Codex Provider relay requires a Base URL resolver.');

  const server = http.createServer((request, response) => {
    relayRequest({ request, response, electronSession, getBaseUrl }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const detail = [error?.cause?.code, error?.cause?.message, error?.message]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join(': ');
      const body = JSON.stringify({
        error: {
          message: `Janus Provider relay failed: ${detail || 'unknown network error'}`,
          type: 'janus_provider_relay_error',
        },
      });
      response.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      response.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function relayRequest({ request, response, electronSession, getBaseUrl }) {
  const target = providerTargetUrl(getBaseUrl(), request.url || '/');
  const abortController = new AbortController();
  let idleTimer = null;
  let settled = false;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const error = new Error(`Provider relay upstream idle timeout after ${UPSTREAM_IDLE_TIMEOUT_MS}ms.`);
      error.code = 'provider_relay_idle_timeout';
      abortController.abort(error);
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  response.on('close', () => {
    if (!response.writableEnded) abortController.abort();
  });
  const method = String(request.method || 'GET').toUpperCase();
  try {
    const body = ['GET', 'HEAD'].includes(method) ? undefined : await readRequestBody(request);
    resetIdleTimer();
    const upstream = await electronSession.fetch(target, {
      method,
      headers: requestHeaders(request.headers),
      body,
      redirect: 'manual',
      signal: abortController.signal,
    });
    response.statusCode = upstream.status;
    response.statusMessage = upstream.statusText || response.statusMessage;
    for (const [key, value] of upstream.headers.entries()) {
      if (['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue;
      response.setHeader(key, value);
    }
    response.flushHeaders?.();
    if (!upstream.body) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        resetIdleTimer();
        if (!response.write(Buffer.from(chunk.value))) {
          await new Promise((resolve) => response.once('drain', resolve));
        }
      }
      response.end();
    } finally {
      reader.releaseLock();
    }
  } finally {
    settled = true;
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function providerTargetUrl(baseUrl, requestUrl) {
  const base = new URL(String(baseUrl || '').trim());
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Provider Base URL must use HTTP or HTTPS.');
  const incoming = new URL(String(requestUrl || '/'), 'http://127.0.0.1');
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`}`;
  base.search = incoming.search;
  base.hash = '';
  return base.toString();
}

function requestHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (['connection', 'content-length', 'host', 'proxy-connection', 'transfer-encoding'].includes(key.toLowerCase())) continue;
    output[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return output;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_BODY_LIMIT) throw new Error('Provider request body exceeds the relay limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
