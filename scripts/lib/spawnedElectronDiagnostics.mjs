import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { diagnosticError, redactDiagnosticText, redactDiagnosticValue } from './testDiagnostics.mjs';

export async function availableTcpPort(host = '127.0.0.1') {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Unable to allocate a diagnostic TCP port.');
  return port;
}

export async function terminateSpawnedProcess(child, timeoutMs = 3_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }
}

export async function captureSpawnedElectronFailureDiagnostics({
  child,
  error,
  stderr = '',
  port = 0,
  runtimeHome = '',
  name = 'electron',
} = {}) {
  const caseDir = String(process.env.JANUS_TEST_ARTIFACT_DIR || '').trim();
  if (!caseDir) return null;
  const artifactDir = path.join(caseDir, 'artifacts');
  await fsp.mkdir(artifactDir, { recursive: true });
  const safeName = String(name || 'electron').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  let cdpProbe = null;
  if (port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_500) });
      cdpProbe = { status: response.status, body: redactDiagnosticText(await response.text(), { maxLength: 20_000 }) };
    } catch (probeError) {
      cdpProbe = { error: diagnosticError(probeError) };
    }
  }
  const runtimeFiles = runtimeHome ? await listRuntimeFiles(runtimeHome) : [];
  const payload = redactDiagnosticValue({
    schemaVersion: 1,
    runId: process.env.JANUS_TEST_RUN_ID || '',
    caseId: process.env.JANUS_TEST_CASE_ID || '',
    capturedAt: new Date().toISOString(),
    error: diagnosticError(error),
    process: {
      pid: child?.pid || null,
      exitCode: child?.exitCode ?? null,
      signalCode: child?.signalCode || null,
      killed: Boolean(child?.killed),
    },
    port,
    cdpProbe,
    runtimeFiles,
  });
  await fsp.writeFile(path.join(artifactDir, `${safeName}-launch-failure.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.writeFile(path.join(artifactDir, `${safeName}-stderr.log`), `${redactDiagnosticText(stderr, { maxLength: 2 * 1024 * 1024 })}\n`, 'utf8');
  return artifactDir;
}

async function listRuntimeFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= 300) return;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filePath);
      else if (entry.isFile()) {
        const stat = await fsp.stat(filePath).catch(() => ({ size: 0 }));
        files.push({ path: path.relative(root, filePath), size: stat.size });
      }
    }
  }
  await walk(root);
  return files;
}
