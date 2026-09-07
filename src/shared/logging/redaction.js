import crypto from 'node:crypto';

const SENSITIVE_KEY_PARTS = new Set([
  'authorization', 'cookie', 'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey',
  'privatekey', 'clientsecret', 'smtppass', 'verificationcode', 'emailcode', 'refreshtoken', 'accesstoken',
  'email', 'phone', 'username', 'identifier',
]);
const NON_SECRET_TOKEN_METRIC_KEYS = new Set([
  'tokenusage', 'tokensused', 'inputtokens', 'outputtokens', 'totaltokens', 'cachedinputtokens',
  'cachewriteinputtokens', 'reasoningoutputtokens',
]);
const PRIVATE_CONTENT_KEYS = new Set([
  'answer', 'body', 'content', 'filecontent', 'input', 'instruction', 'messages', 'objective', 'output',
  'prompt', 'query', 'requestbody', 'response', 'responsebody', 'stderr', 'stdin', 'stdout', 'text',
]);
const EMAIL_RE = /\b([A-Z0-9._%+-])([A-Z0-9._%+-]*)(@(?:[A-Z0-9-]+\.)+[A-Z]{2,})\b/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const GITHUB_KEY_RE = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const SLACK_KEY_RE = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const PEM_RE = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const URL_CREDENTIAL_RE = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const ASSIGNMENT_SECRET_RE = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|smtp[_-]?pass|verification[_-]?code|email[_-]?code)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const JSON_SECRET_RE = /(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|smtp[_-]?pass|verification[_-]?code|email[_-]?code)["']\s*:\s*["'])(.*?)(["'])/gi;
const PASSWORD_INPUT_RE = /(<input\b(?=[^>]*\btype=["']password["'])[^>]*\bvalue=["'])(.*?)(["'])/gi;

export function newDiagnosticId(prefix = 'diag') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function redactDiagnosticText(value, { maxLength = 16_384, env = process.env } = {}) {
  let text = String(value ?? '');
  text = text.replace(PEM_RE, '[REDACTED_PEM]');
  text = text.replace(BEARER_RE, '$1 [REDACTED]');
  text = text.replace(JWT_RE, '[REDACTED_JWT]');
  text = text.replace(OPENAI_KEY_RE, '[REDACTED_API_KEY]');
  text = text.replace(GITHUB_KEY_RE, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(SLACK_KEY_RE, '[REDACTED_SLACK_TOKEN]');
  text = text.replace(AWS_ACCESS_KEY_RE, '[REDACTED_AWS_ACCESS_KEY]');
  text = text.replace(URL_CREDENTIAL_RE, '$1[REDACTED]@');
  text = text.replace(JSON_SECRET_RE, '$1[REDACTED]$3');
  text = text.replace(PASSWORD_INPUT_RE, '$1[REDACTED]$3');
  text = text.replace(ASSIGNMENT_SECRET_RE, '$1$2[REDACTED]');
  text = text.replace(EMAIL_RE, (_match, first, _middle, domain) => `${first}***${domain}`);

  const home = String(env.HOME || env.USERPROFILE || '').trim();
  const temp = String(env.TMPDIR || env.TEMP || env.TMP || '').trim();
  if (home) text = replaceAllLiteral(text, home, '$HOME');
  if (temp) text = replaceAllLiteral(text, temp, '$TMP');

  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

export function redactDiagnosticValue(value, options = {}, seen = new WeakSet(), key = '') {
  if (isSensitiveDiagnosticKey(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactDiagnosticText(value, options);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) return diagnosticError(value, options);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactDiagnosticValue(item, options, seen));
  if (typeof value !== 'object') return redactDiagnosticText(String(value), options);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 300)) {
    result[entryKey] = redactDiagnosticValue(entryValue, options, seen, entryKey);
  }
  seen.delete(value);
  return result;
}

export function sanitizeLogMetadata(value, options = {}, seen = new WeakSet(), key = '') {
  const compactKey = normalizeKey(key);
  if (PRIVATE_CONTENT_KEYS.has(compactKey) || isSensitiveDiagnosticKey(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactDiagnosticText(value, { ...options, maxLength: Math.min(4_096, options.maxLength || 4_096) });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) return diagnosticError(value, options);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeLogMetadata(item, options, seen));
  if (typeof value !== 'object') return redactDiagnosticText(String(value), options);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, 200)) {
    result[entryKey] = sanitizeLogMetadata(entryValue, options, seen, entryKey);
  }
  seen.delete(value);
  return result;
}

export function diagnosticError(error, options = {}) {
  if (!error) return null;
  return {
    name: redactDiagnosticText(error.name || 'Error', options),
    code: redactDiagnosticText(error.code || '', options),
    message: redactDiagnosticText(error.message || String(error), { ...options, maxLength: 4_096 }),
    stack: redactDiagnosticText(error.stack || '', { ...options, maxLength: 32_768 }),
    status: Number.isFinite(error.status) ? error.status : undefined,
    method: redactDiagnosticText(error.method || '', options),
    route: redactDiagnosticText(error.route || '', options),
    requestId: redactDiagnosticText(error.requestId || '', options),
  };
}

export function isSensitiveDiagnosticKey(value) {
  const normalized = String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (NON_SECRET_TOKEN_METRIC_KEYS.has(compact)) return false;
  if (SENSITIVE_KEY_PARTS.has(compact)) return true;
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.includes('authorization') || parts.includes('cookie') || parts.includes('password') || parts.includes('passwd') || parts.includes('passphrase')) return true;
  if (parts.includes('secret') || parts.includes('token')) return true;
  return parts.includes('key') && parts.some((part) => ['api', 'private', 'client', 'signing'].includes(part));
}

function normalizeKey(value = '') {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function replaceAllLiteral(value, needle, replacement) {
  return needle ? String(value).split(needle).join(replacement) : String(value);
}
