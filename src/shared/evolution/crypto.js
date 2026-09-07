import crypto from 'node:crypto';

export function evolutionKeyringFromEnv(env = process.env) {
  let keys = {};
  try { keys = JSON.parse(env.JANUS_EVOLUTION_KEYS_JSON || '{}'); } catch { keys = {}; }
  const activeKeyId = String(env.JANUS_EVOLUTION_ACTIVE_KEY_ID || Object.keys(keys)[0] || '').trim();
  const allowPlaintextTestOnly = ['1', 'true', 'yes', 'on'].includes(String(env.JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY || '').trim().toLowerCase());
  return { activeKeyId, keys, allowPlaintextTestOnly };
}

export function evolutionEncryptionReady(keyring = evolutionKeyringFromEnv()) {
  try { return Boolean(decodeKey(keyring.keys?.[keyring.activeKeyId])); } catch { return false; }
}

export function evolutionEnvelopePublicKeyringFromEnv(env = process.env) {
  return asymmetricKeyring(env.JANUS_EVOLUTION_WORKER_PUBLIC_KEYS_JSON,env.JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID);
}

export function evolutionEnvelopePrivateKeyringFromEnv(env = process.env) {
  return asymmetricKeyring(env.JANUS_EVOLUTION_WORKER_PRIVATE_KEYS_JSON,env.JANUS_EVOLUTION_WORKER_ACTIVE_KEY_ID);
}

export function evolutionWorkerDecryptionKeyringFromEnv(env = process.env) {
  const symmetric=evolutionKeyringFromEnv(env),asymmetric=evolutionEnvelopePrivateKeyringFromEnv(env);
  return {activeKeyId:symmetric.activeKeyId,keys:{...(symmetric.keys||{}),...(asymmetric.keys||{})},
    allowPlaintextTestOnly:symmetric.allowPlaintextTestOnly};
}

export function evolutionEnvelopeCapability(keyring = evolutionEnvelopePublicKeyringFromEnv()) {
  const keyId=String(keyring.activeKeyId||'');
  return {available:Boolean(keyId&&keyring.keys?.[keyId]),algorithm:'aes-256-gcm+rsa-oaep-sha256',
    keyWrapAlgorithm:'rsa-oaep-sha256',activeKeyId:keyId,keyVersion:1,publicKey:keyring.keys?.[keyId]||''};
}

export function encryptEvolutionEnvelope(value,keyring=evolutionEnvelopePublicKeyringFromEnv()) {
  const keyId=String(keyring.activeKeyId||'');const publicKey=keyring.keys?.[keyId];
  if(!keyId||!publicKey)throw new Error('Evolution Worker public key is not configured.');
  const dataKey=crypto.randomBytes(32),nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',dataKey,nonce);
  const plaintext=Buffer.from(typeof value==='string'?value:JSON.stringify(value??null),'utf8');
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const wrappedDataKey=crypto.publicEncrypt({key:publicKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},dataKey);
  return {algorithm:'aes-256-gcm+rsa-oaep-sha256',keyId,keyVersion:1,keyWrapAlgorithm:'rsa-oaep-sha256',
    wrappedDataKey:wrappedDataKey.toString('base64'),ciphertext:ciphertext.toString('base64'),nonce:nonce.toString('base64'),
    tag:cipher.getAuthTag().toString('base64'),envelopeFormat:'evolution_envelope_v1'};
}

export function encryptEvolutionPayload(value, keyring = evolutionKeyringFromEnv()) {
  const plaintext = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8');
  const key = decodeKey(keyring.keys?.[keyring.activeKeyId]);
  if (!key) {
    if (keyring.allowPlaintextTestOnly) return { algorithm: 'plain_test_only', keyId: '', ciphertext: plaintext.toString('base64'), nonce: '', tag: '' };
    throw new Error('Evolution encryption key is not configured.');
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { algorithm: 'aes-256-gcm', keyId: keyring.activeKeyId, ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function rewrapEvolutionEnvelope(record = {}, {
  privateKeyring = evolutionEnvelopePrivateKeyringFromEnv(),
  publicKeyring = evolutionEnvelopePublicKeyringFromEnv(),
  targetKeyId = publicKeyring.activeKeyId,
} = {}) {
  if (record.algorithm !== 'aes-256-gcm+rsa-oaep-sha256') throw new Error('Only Evolution envelopes can be rewrapped.');
  const sourcePrivateKey = privateKeyring.keys?.[record.keyId];
  if (!sourcePrivateKey) throw new Error(`Evolution Worker private key is unavailable: ${record.keyId || 'missing'}`);
  const targetPublicKey = publicKeyring.keys?.[targetKeyId];
  if (!targetKeyId || !targetPublicKey) throw new Error(`Evolution Worker public key is unavailable: ${targetKeyId || 'missing'}`);
  const dataKey = crypto.privateDecrypt({
    key: sourcePrivateKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, Buffer.from(record.wrappedDataKey || record.wrapped_data_key || '', 'base64'));
  const wrappedDataKey = crypto.publicEncrypt({
    key: targetPublicKey,
    oaepHash: 'sha256',
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
  }, dataKey);
  return {
    ...record,
    keyId: targetKeyId,
    keyVersion: Number(record.keyVersion || record.key_version || 0) + 1,
    keyWrapAlgorithm: 'rsa-oaep-sha256',
    wrappedDataKey: wrappedDataKey.toString('base64'),
    envelopeFormat: 'evolution_envelope_v1',
  };
}

export function decryptEvolutionPayload(record = {}, keyring = evolutionKeyringFromEnv()) {
  if(record.algorithm==='aes-256-gcm+rsa-oaep-sha256'){
    const privateKey=keyring.keys?.[record.keyId];
    if(!privateKey)throw new Error(`Evolution Worker private key is unavailable: ${record.keyId||'missing'}`);
    const dataKey=crypto.privateDecrypt({key:privateKey,oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},
      Buffer.from(record.wrappedDataKey||record.wrapped_data_key||'','base64'));
    const decipher=crypto.createDecipheriv('aes-256-gcm',dataKey,Buffer.from(record.nonce||'','base64'));
    decipher.setAuthTag(Buffer.from(record.tag||'','base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext||'','base64')),decipher.final()]).toString('utf8');
  }
  if (record.algorithm === 'plain_test_only') {
    if (!keyring.allowPlaintextTestOnly) throw new Error('Plaintext evolution payloads are disabled.');
    return Buffer.from(record.ciphertext || '', 'base64').toString('utf8');
  }
  if (!record.keyId) throw new Error('Evolution payload key ID is missing.');
  const key = decodeKey(keyring.keys?.[record.keyId]);
  if (!key) throw new Error(`Evolution encryption key is unavailable: ${record.keyId}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce || '', 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag || '', 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext || '', 'base64')), decipher.final()]).toString('utf8');
}

function asymmetricKeyring(json='',activeKeyId=''){
  let keys={};try{keys=JSON.parse(json||'{}');}catch{keys={};}
  return {activeKeyId:String(activeKeyId||Object.keys(keys)[0]||'').trim(),keys};
}

function decodeKey(value) {
  if (!value) return null;
  const key = Buffer.from(String(value), 'base64');
  if (key.length !== 32) throw new Error('Evolution encryption keys must be 32-byte base64 values.');
  return key;
}
