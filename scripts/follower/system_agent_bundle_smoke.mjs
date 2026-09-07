import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyFollowerSystemAgentBundle,
  buildFollowerSystemAgentBundle,
  followerEffectiveAssetPath,
  readFollowerSystemAgentBundle,
  rollbackFollowerSystemAgentBundle,
  signFollowerSystemAgentBundle,
  validateFollowerSystemAgentBundle,
  verifyFollowerSystemAgentBundle,
} from '../../src/shared/follower/systemAgentBundle.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-bundle-'));
try {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const files = [
    { path: 'agent.json', content: '{"id":"follower_agent"}\n' },
    { path: 'SKILL.md', content: '# Follower v1\n' },
  ];
  const first = buildFollowerSystemAgentBundle({ files, releaseVersion: '1.0.1', minAppVersion: '1.0.0' });
  signFollowerSystemAgentBundle(first, { privateKeyPem });
  validateFollowerSystemAgentBundle(first, { appVersion: '1.0.0' });
  assert.equal(verifyFollowerSystemAgentBundle(first, { publicKeyPem }).valid, true);
  applyFollowerSystemAgentBundle({ root, bundle: first, appVersion: '1.0.0' });
  const second = buildFollowerSystemAgentBundle({ files: files.map((item) => item.path === 'SKILL.md' ? { ...item, content: '# Follower v2\n' } : item),
    releaseVersion: '1.0.2', minAppVersion: '1.0.0' });
  signFollowerSystemAgentBundle(second, { privateKeyPem });
  applyFollowerSystemAgentBundle({ root, bundle: second, appVersion: '1.0.0' });
  assert.match(fs.readFileSync(followerEffectiveAssetPath(root, 'SKILL.md'), 'utf8'), /v2/);
  const rolledBack = rollbackFollowerSystemAgentBundle({ root });
  assert.equal(rolledBack.bundleId, first.bundleId);
  assert.match(fs.readFileSync(followerEffectiveAssetPath(root, 'SKILL.md'), 'utf8'), /v1/);
  assert.equal(readFollowerSystemAgentBundle(root).rolledBackFrom, second.bundleId);
  const tampered = structuredClone(first); tampered.files[1].content = '# tampered\n';
  assert.throws(() => validateFollowerSystemAgentBundle(tampered, { appVersion: '1.0.0' }), /hash mismatch|identity mismatch/);
  assert.throws(() => validateFollowerSystemAgentBundle(first, { appVersion: '0.9.9' }), /newer Janus/);
  console.log('Follower system-agent bundle smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
