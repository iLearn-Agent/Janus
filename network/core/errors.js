export class NetworkRequestError extends Error {
  constructor(message, { status = 0, method = '', url = '', route = '', body = null, code = '', details = null, requestId = '' } = {}) {
    super(message);
    this.name = 'NetworkRequestError';
    this.status = status;
    this.method = method;
    this.url = url;
    this.route = route;
    this.body = body;
    this.code = String(code || body?.error?.code || body?.code || '');
    this.details = details ?? body?.error?.details ?? body?.details ?? null;
    this.requestId = String(requestId || '');
  }
}

export function responseDetail({ parsed = null, text = '', fallback = '' } = {}) {
  return parsed?.error?.message || parsed?.error || parsed?.message || text || fallback;
}
