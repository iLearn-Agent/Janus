import crypto from 'node:crypto';

import { createS3ObjectStore } from '../cloud/src/modules/sync/objectStore.mjs';

const allowed = String(process.env.JANUS_ALLOW_S3_REHEARSAL || '').toLowerCase() === 'true';
const store = createS3ObjectStore({ env: process.env });
if (!allowed || !store.available) {
  console.log('Sync V6 S3 rehearsal skipped: configure JANUS_S3_* and set JANUS_ALLOW_S3_REHEARSAL=true.');
  process.exit(0);
}

const body = crypto.randomBytes(4096);
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const objectKey = `rehearsals/sync-v6/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`;
let uploaded = false;
try {
  const upload = await store.initiateUpload({ objectKey, sha256, sizeBytes: body.length, contentType: 'application/octet-stream' });
  const uploadResponse = await fetch(upload.url, { method: upload.method, headers: upload.headers, body });
  if (!uploadResponse.ok) throw new Error(`S3 rehearsal upload failed with ${uploadResponse.status}.`);
  uploaded = true;
  const head = await store.headObject({ objectKey });
  const expectedChecksum = Buffer.from(sha256, 'hex').toString('base64');
  if (!head || head.sizeBytes !== body.length || head.checksumSha256 !== expectedChecksum) {
    throw new Error('S3 rehearsal HEAD size/checksum verification failed.');
  }
  const download = await store.downloadUrl({ objectKey });
  const downloadResponse = await fetch(download.url);
  if (!downloadResponse.ok) throw new Error(`S3 rehearsal download failed with ${downloadResponse.status}.`);
  const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
  if (!downloaded.equals(body)) throw new Error('S3 rehearsal download content mismatch.');
  console.log(`Sync V6 S3 rehearsal passed: ${objectKey}`);
} finally {
  if (uploaded) await store.deleteObject({ objectKey }).catch((error) => console.error(`S3 rehearsal cleanup failed: ${error.message}`));
}
