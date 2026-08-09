export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

export function joinUrl(baseUrl, route = '') {
  return new URL(route, `${normalizeBaseUrl(baseUrl)}/`).toString();
}
