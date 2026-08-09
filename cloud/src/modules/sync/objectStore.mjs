import crypto from 'node:crypto';

export function createS3ObjectStore({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = s3Config(env);
  return {
    available: Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey),
    async initiateUpload({ objectKey, sha256, sizeBytes, contentType = 'application/octet-stream', expiresSeconds = 900 }) {
      requireAvailable(config);
      const checksum = Buffer.from(sha256, 'hex').toString('base64');
      const headers = { 'content-type': contentType, 'x-amz-checksum-sha256': checksum };
      return {
        method: 'PUT', url: presignedUrl(config, 'PUT', objectKey, {
          endpoint: config.publicEndpoint, expiresSeconds, signedHeaders: headers,
        }),
        headers, expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(), sizeBytes,
      };
    },
    async headObject({ objectKey }) {
      requireAvailable(config);
      const headers = { 'x-amz-checksum-mode': 'ENABLED' };
      const url = presignedUrl(config, 'HEAD', objectKey, { expiresSeconds: 60, signedHeaders: headers });
      const response = await fetchImpl(url, { method: 'HEAD', headers });
      if (response.status === 404) return null;
      if (!response.ok) throw storageError('object_store_head_failed', `Object store HEAD failed with ${response.status}.`);
      return {
        sizeBytes: Number(response.headers.get('content-length') || 0),
        checksumSha256: response.headers.get('x-amz-checksum-sha256') || response.headers.get('x-amz-meta-sha256') || '',
        etag: String(response.headers.get('etag') || '').replaceAll('"', ''),
      };
    },
    async downloadUrl({ objectKey, expiresSeconds = 300 }) {
      requireAvailable(config);
      return {
        url: presignedUrl(config, 'GET', objectKey, { endpoint: config.publicEndpoint, expiresSeconds }),
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
      };
    },
    async deleteObject({ objectKey }) {
      requireAvailable(config);
      const url = presignedUrl(config, 'DELETE', objectKey, { expiresSeconds: 60 });
      const response = await fetchImpl(url, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw storageError('object_store_delete_failed', `Object store DELETE failed with ${response.status}.`);
      return { status: response.status === 404 ? 'not_found' : 'deleted' };
    },
  };
}

export function createMemoryObjectStore() {
  const objects = new Map();
  return {
    available: true,
    objects,
    async initiateUpload({ objectKey, sha256, sizeBytes, contentType, expiresSeconds = 900 }) {
      return { method: 'PUT', url: `memory://upload/${encodeURIComponent(objectKey)}`, headers: { 'x-janus-sha256': sha256 },
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(), sizeBytes, contentType };
    },
    async headObject({ objectKey }) { return objects.get(objectKey) || null; },
    async downloadUrl({ objectKey, expiresSeconds = 300 }) {
      if (!objects.has(objectKey)) throw storageError('object_not_found', 'Object was not found.');
      return { url: `memory://download/${encodeURIComponent(objectKey)}`, expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString() };
    },
    async deleteObject({ objectKey }) { return { status: objects.delete(objectKey) ? 'deleted' : 'not_found' }; },
    put({ objectKey, body, contentType = 'application/octet-stream' }) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      objects.set(objectKey, { sizeBytes: buffer.length, checksumSha256: Buffer.from(hash, 'hex').toString('base64'), contentType, body: buffer });
    },
  };
}

function s3Config(env) {
  const endpoint = String(env.JANUS_S3_ENDPOINT || '').replace(/\/+$/, '');
  return {
    endpoint,
    publicEndpoint: String(env.JANUS_S3_PUBLIC_ENDPOINT || endpoint).replace(/\/+$/, ''),
    region: String(env.JANUS_S3_REGION || 'us-east-1'),
    bucket: String(env.JANUS_S3_BUCKET || ''),
    accessKeyId: String(env.JANUS_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || ''),
    secretAccessKey: String(env.JANUS_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || ''),
    sessionToken: String(env.JANUS_S3_SESSION_TOKEN || env.AWS_SESSION_TOKEN || ''),
    forcePathStyle: String(env.JANUS_S3_FORCE_PATH_STYLE || 'true').toLowerCase() !== 'false',
  };
}

function presignedUrl(config, method, objectKey, { endpoint = config.endpoint, expiresSeconds = 300, signedHeaders = {} } = {}) {
  const now = new Date();
  const amzDate = isoAmz(now);
  const date = amzDate.slice(0, 8);
  const credentialScope = `${date}/${config.region}/s3/aws4_request`;
  const target = objectTarget({ ...config, endpoint }, objectKey);
  const headers = { host: target.host, ...lowerHeaders(signedHeaders) };
  const signedHeaderNames = Object.keys(headers).sort();
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(3600, Math.max(1, Number(expiresSeconds || 300)))),
    'X-Amz-SignedHeaders': signedHeaderNames.join(';'),
  });
  if (config.sessionToken) query.set('X-Amz-Security-Token', config.sessionToken);
  const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${awsEncode(key)}=${awsEncode(value)}`).join('&');
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
  const canonicalRequest = [method, target.canonicalPath, canonicalQuery, canonicalHeaders, signedHeaderNames.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(config.secretAccessKey, date, config.region), stringToSign, 'hex');
  return `${target.origin}${target.canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function objectTarget(config, objectKey) {
  const endpoint = new URL(config.endpoint);
  const encodedKey = String(objectKey).split('/').map(awsEncode).join('/');
  if (config.forcePathStyle) {
    return { origin: endpoint.origin, host: endpoint.host, canonicalPath: `${endpoint.pathname.replace(/\/$/, '')}/${awsEncode(config.bucket)}/${encodedKey}`.replace(/^$/, '/') };
  }
  const host = `${config.bucket}.${endpoint.host}`;
  return { origin: `${endpoint.protocol}//${host}`, host, canonicalPath: `${endpoint.pathname.replace(/\/$/, '')}/${encodedKey}`.replace(/^$/, '/') };
}

function signingKey(secret, date, region) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}
function lowerHeaders(headers) { return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])); }
function isoAmz(date) { return date.toISOString().replace(/[:-]|\.\d{3}/g, ''); }
function awsEncode(value) { return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function hmac(key, value, encoding) { return crypto.createHmac('sha256', key).update(value).digest(encoding); }
function requireAvailable(config) { if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) throw storageError('object_store_unavailable', 'S3-compatible object storage is not configured.'); }
function storageError(code, message) { const error = new Error(message); error.code = code; error.status = code === 'object_not_found' ? 404 : 503; return error; }
