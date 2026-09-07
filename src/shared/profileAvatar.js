export const MAX_PROFILE_AVATAR_URL_LENGTH = 200_000;

const DATA_IMAGE_PATTERN = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i;
const REMOTE_IMAGE_PATTERN = /^https:/i;
const LEGACY_INSECURE_REMOTE_IMAGE_PATTERN = /^http:/i;
const LEGACY_LOCAL_IMAGE_PATTERN = /^(?:file:|blob:|janus:)/i;

export function profileAvatarUrlValidation(value = '', { allowLegacyLocal = false } = {}) {
  const clean = String(value || '').trim();
  if (!clean) return { valid: true, value: '', reason: '' };
  if (clean.length > MAX_PROFILE_AVATAR_URL_LENGTH) {
    return { valid: false, value: '', reason: '头像图片数据过大，请重新选择图片。' };
  }
  if (REMOTE_IMAGE_PATTERN.test(clean)) return { valid: true, value: clean, reason: '' };
  if (LEGACY_INSECURE_REMOTE_IMAGE_PATTERN.test(clean)) {
    return allowLegacyLocal
      ? { valid: true, value: clean, reason: '' }
      : { valid: false, value: '', reason: '头像远程地址必须使用 HTTPS，请重新选择图片。' };
  }
  if (LEGACY_LOCAL_IMAGE_PATTERN.test(clean)) {
    return allowLegacyLocal
      ? { valid: true, value: clean, reason: '' }
      : { valid: false, value: '', reason: '头像不能使用仅本机可访问的地址，请重新选择图片。' };
  }
  const match = clean.match(DATA_IMAGE_PATTERN);
  if (!match) return { valid: false, value: '', reason: '头像图片格式无效，请重新选择图片。' };
  const [, kind, payload] = match;
  const decodedLength = base64DecodedLength(payload);
  if (decodedLength < 24) return { valid: false, value: '', reason: '头像图片数据不完整，请重新选择图片。' };
  const header = decodeBase64Prefix(payload, 16);
  if (!imageHeaderMatches(kind, header)) return { valid: false, value: '', reason: '头像图片内容与格式不匹配，请重新选择图片。' };
  if (kind.toLowerCase() === 'webp') {
    const declaredLength = readUint32Le(header, 4) + 8;
    if (declaredLength > decodedLength) return { valid: false, value: '', reason: '头像图片数据已被截断，请重新选择图片。' };
  }
  return { valid: true, value: clean, reason: '' };
}

export function normalizeProfileAvatarUrl(value = '', { allowLegacyLocal = true } = {}) {
  const result = profileAvatarUrlValidation(value, { allowLegacyLocal });
  return result.valid ? result.value : '';
}

function base64DecodedLength(payload = '') {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function decodeBase64Prefix(payload = '', limit = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of payload) {
    if (char === '=') break;
    const value = alphabet.indexOf(char);
    if (value < 0) return [];
    buffer = (buffer << 6) | value;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      if (bytes.length >= limit) return bytes;
    }
  }
  return bytes;
}

function imageHeaderMatches(kind = '', bytes = []) {
  const type = String(kind || '').toLowerCase();
  if (type === 'webp') return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
  if (type === 'png') return bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
  if (type === 'jpg' || type === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'gif') return ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6));
  return false;
}

function ascii(bytes = [], start = 0, end = bytes.length) {
  return bytes.slice(start, end).map((byte) => String.fromCharCode(byte)).join('');
}

function readUint32Le(bytes = [], offset = 0) {
  return ((bytes[offset] || 0)
    | ((bytes[offset + 1] || 0) << 8)
    | ((bytes[offset + 2] || 0) << 16)
    | ((bytes[offset + 3] || 0) << 24)) >>> 0;
}
