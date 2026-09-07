#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyWindowsAuthenticode(filePath, {
  expectedPublisher = process.env.JANUS_WINDOWS_PUBLISHER_NAME || '',
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Windows Authenticode input does not exist: ${resolved || '(empty)'}`);
  }
  if (!resolved.toLowerCase().endsWith('.exe')) throw new Error(`Windows Authenticode verification requires an EXE: ${resolved}`);

  const result = platform === 'win32'
    ? verifyWithPowerShell(resolved, spawn)
    : verifyWithOsslSigncode(resolved, spawn);
  const publisher = String(expectedPublisher || '').trim();
  if (publisher && !result.output.toLocaleLowerCase().includes(publisher.toLocaleLowerCase())) {
    throw new Error(`Authenticode signer for ${path.basename(resolved)} does not match required publisher: ${publisher}`);
  }
  return { file: resolved, verifier: result.verifier, publisher: publisher || '', valid: true };
}

export function verifyWindowsUnsigned(filePath, {
  platform = process.platform,
  spawn = spawnSync,
} = {}) {
  const resolved = resolveWindowsExecutable(filePath);
  const result = platform === 'win32'
    ? inspectWithPowerShell(resolved, spawn)
    : inspectWithOsslSigncode(resolved, spawn);
  if (result.signed) {
    throw new Error(`Windows executable is signed but an explicitly unsigned release was required: ${path.basename(resolved)}`);
  }
  return { file: resolved, verifier: result.verifier, publisher: '', valid: true, signed: false };
}

function verifyWithPowerShell(filePath, spawn) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:JANUS_AUTHENTICODE_FILE',
    '$payload = [ordered]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject; Thumbprint = [string]$signature.SignerCertificate.Thumbprint; TimestampSubject = [string]$signature.TimeStamperCertificate.Subject }',
    '$payload | ConvertTo-Json -Compress',
    'if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) { exit 1 }',
  ].join('; ');
  const result = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, JANUS_AUTHENTICODE_FILE: filePath },
  });
  return checkedResult(result, 'PowerShell Get-AuthenticodeSignature', filePath);
}

function inspectWithPowerShell(filePath, spawn) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:JANUS_AUTHENTICODE_FILE',
    '$payload = [ordered]@{ Status = [string]$signature.Status; Subject = [string]$signature.SignerCertificate.Subject; Thumbprint = [string]$signature.SignerCertificate.Thumbprint }',
    '$payload | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, JANUS_AUTHENTICODE_FILE: filePath },
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0) throw new Error(`PowerShell Get-AuthenticodeSignature could not inspect ${path.basename(filePath)}${output ? `:\n${output}` : ''}`);
  let status = '';
  try {
    status = String(JSON.parse(result.stdout || '{}').Status || '');
  } catch {
    status = '';
  }
  if (status !== 'NotSigned') {
    throw new Error(`Expected an unsigned Windows executable, but signature status is ${status || 'unknown'}: ${path.basename(filePath)}`);
  }
  return { verifier: 'PowerShell Get-AuthenticodeSignature', output, signed: false };
}

function verifyWithOsslSigncode(filePath, spawn) {
  const probe = spawn('osslsigncode', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') {
    throw new Error('osslsigncode is required to verify Windows Authenticode signatures before publishing.');
  }
  const result = spawn('osslsigncode', ['verify', '-in', filePath], { encoding: 'utf8', windowsHide: true });
  return checkedResult(result, 'osslsigncode', filePath);
}

function inspectWithOsslSigncode(filePath, spawn) {
  const probe = spawn('osslsigncode', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error?.code === 'ENOENT') {
    throw new Error('osslsigncode is required to verify that a Windows release is unsigned before publishing.');
  }
  const result = spawn('osslsigncode', ['verify', '-in', filePath], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0 && /No signature found/i.test(output)) {
    return { verifier: 'osslsigncode', output, signed: false };
  }
  if (result.status === 0) {
    return { verifier: 'osslsigncode', output, signed: true };
  }
  throw new Error(`osslsigncode could not establish an unsigned Windows executable: ${path.basename(filePath)}${output ? `:\n${output}` : ''}`);
}

function resolveWindowsExecutable(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Windows Authenticode input does not exist: ${resolved || '(empty)'}`);
  }
  if (!resolved.toLowerCase().endsWith('.exe')) throw new Error(`Windows Authenticode verification requires an EXE: ${resolved}`);
  return resolved;
}

function checkedResult(result, verifier, filePath) {
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`${verifier} rejected ${path.basename(filePath)}${output ? `:\n${output}` : ''}`);
  }
  return { verifier, output };
}

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const files = argumentValues('--file');
  if (!files.length) throw new Error('At least one --file <path> is required.');
  const expectedPublisher = argumentValues('--publisher').at(-1) || process.env.JANUS_WINDOWS_PUBLISHER_NAME || '';
  const expectUnsigned = process.argv.includes('--expect-unsigned');
  const results = files.map((file) => expectUnsigned
    ? verifyWindowsUnsigned(file)
    : verifyWindowsAuthenticode(file, { expectedPublisher }));
  process.stdout.write(`${JSON.stringify({ status: 'valid', files: results }, null, 2)}\n`);
}
