import crypto from 'node:crypto';

import { passwordValidationMessage } from '../../../../shared/passwordPolicy.js';

const HASH_ITERATIONS = 210_000;
const HASH_KEYLEN = 32;
const HASH_DIGEST = 'sha256';

export function validatePassword(password) {
  const message = passwordValidationMessage(password);
  if (message) throw new Error(message);
  return String(password || '');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
  return `pbkdf2:${HASH_DIGEST}:${HASH_ITERATIONS}:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return String(password || '') === '';
  const parts = String(stored || '').split(':');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterations, salt, hash] = parts;
  const candidate = crypto.pbkdf2Sync(String(password || ''), salt, Number(iterations), HASH_KEYLEN, digest).toString('hex');
  const left = Buffer.from(candidate, 'hex');
  const right = Buffer.from(hash, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
