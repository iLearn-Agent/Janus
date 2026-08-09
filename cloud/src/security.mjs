import crypto from 'node:crypto';

const PASSWORD_ITERATIONS = 310_000;
const PASSWORD_KEYLEN = 32;
const PASSWORD_DIGEST = 'sha256';

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

export function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

export function randomToken() {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('base64url');
  return `pbkdf2$${PASSWORD_DIGEST}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password, encoded = '') {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, rawIterations, salt, expected] = parts;
  const iterations = Number(rawIterations);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, Buffer.from(expected, 'base64url').length, digest).toString('base64url');
  return safeEqual(actual, expected);
}

export function hashSecret(value, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('base64url');
}

export function hashEmailCode({ email, purpose, code, secret }) {
  return hashSecret(`${normalizeHashPart(email)}:${normalizeHashPart(purpose)}:${String(code).trim()}`, secret);
}

export function hashRefreshToken(token, secret) {
  return hashSecret(`refresh:${String(token)}`, secret);
}

export function signAccessToken({ userId, secret, expiresInSeconds = 900 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: userId,
    typ: 'access',
    iat: now,
    exp: now + expiresInSeconds,
  };
  const unsigned = `${base64Json(header)}.${base64Json(payload)}`;
  return `${unsigned}.${hmacJwt(unsigned, secret)}`;
}

export function signOrganizationSecondaryVerificationGrant({
  userId, organizationId, secret, expiresInSeconds = 7 * 24 * 60 * 60,
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: String(userId || ''),
    org: String(organizationId || ''),
    typ: 'organization_secondary_verification',
    iat: now,
    exp: now + Math.max(60, Number(expiresInSeconds || 0)),
  };
  const unsigned = `${base64Json(header)}.${base64Json(payload)}`;
  return `${unsigned}.${hmacJwt(unsigned, secret)}`;
}

export function verifyOrganizationSecondaryVerificationGrant(token, {
  userId = '', organizationId = '', secret = '',
} = {}) {
  const parsed = verifySignedPayload(token, secret);
  if (parsed.typ !== 'organization_secondary_verification'
    || parsed.sub !== String(userId || '')
    || parsed.org !== String(organizationId || '')) {
    throw new Error('bad_secondary_verification_scope');
  }
  return parsed;
}

export function verifyAccessToken(token, secret) {
  const parsed = verifySignedPayload(token, secret);
  if (parsed.typ !== 'access' || !parsed.sub) throw new Error('bad_payload');
  return parsed;
}

function verifySignedPayload(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad_token');
  const [header, payload, signature] = parts;
  const expected = hmacJwt(`${header}.${payload}`, secret);
  if (!safeEqual(signature, expected)) throw new Error('bad_signature');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (Number(parsed.exp || 0) <= Math.floor(Date.now() / 1000)) throw new Error('expired_token');
  return parsed;
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function hmacJwt(value, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeHashPart(value) {
  return String(value || '').trim().toLowerCase();
}
