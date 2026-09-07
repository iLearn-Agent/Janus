import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyWindowsAuthenticode, verifyWindowsUnsigned } from './verify_windows_authenticode.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-authenticode-gate-'));
const installer = path.join(root, 'Janus Setup.exe');
fs.writeFileSync(installer, 'MZ-authenticode-fixture');

try {
  const validSpawn = () => ({
    status: 0,
    stdout: JSON.stringify({ Status: 'Valid', Subject: 'CN=Janus Software LLC', Thumbprint: 'fixture' }),
    stderr: '',
  });
  const verified = verifyWindowsAuthenticode(installer, {
    platform: 'win32', expectedPublisher: 'Janus Software LLC', spawn: validSpawn,
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.verifier, 'PowerShell Get-AuthenticodeSignature');

  assert.throws(() => verifyWindowsAuthenticode(installer, {
    platform: 'win32', expectedPublisher: 'Different Publisher', spawn: validSpawn,
  }), /does not match required publisher/);

  assert.throws(() => verifyWindowsAuthenticode(installer, {
    platform: 'win32', spawn: () => ({ status: 1, stdout: '{"Status":"NotSigned"}', stderr: '' }),
  }), /rejected/);

  assert.throws(() => verifyWindowsAuthenticode(installer, {
    platform: 'linux', spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
  }), /osslsigncode is required/);

  const unsignedLinuxSpawn = (_command, args) => args[0] === '--version'
    ? { status: 0, stdout: 'osslsigncode test fixture', stderr: '' }
    : { status: 1, stdout: 'No signature found', stderr: '' };
  const unsigned = verifyWindowsUnsigned(installer, { platform: 'linux', spawn: unsignedLinuxSpawn });
  assert.equal(unsigned.valid, true);
  assert.equal(unsigned.signed, false);

  assert.throws(() => verifyWindowsUnsigned(installer, {
    platform: 'linux',
    spawn: (_command, args) => args[0] === '--version'
      ? { status: 0, stdout: 'osslsigncode test fixture', stderr: '' }
      : { status: 0, stdout: 'Signature verification: ok', stderr: '' },
  }), /is signed but an explicitly unsigned release was required/);

  const unsignedWindows = verifyWindowsUnsigned(installer, {
    platform: 'win32',
    spawn: () => ({ status: 0, stdout: '{"Status":"NotSigned","Subject":"","Thumbprint":""}', stderr: '' }),
  });
  assert.equal(unsignedWindows.signed, false);

  console.log('Windows Authenticode release gate smoke passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
