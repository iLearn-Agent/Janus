import fsp from 'node:fs/promises';
import path from 'node:path';

import { diagnosticError, redactDiagnosticValue } from './testDiagnostics.mjs';

export async function captureElectronFailureDiagnostics({
  browserWindow,
  error,
  name = 'renderer',
  stateExpression = 'null',
} = {}) {
  const caseDir = String(process.env.JANUS_TEST_ARTIFACT_DIR || '').trim();
  if (!caseDir) return null;
  const artifactDir = path.join(caseDir, 'artifacts');
  await fsp.mkdir(artifactDir, { recursive: true });
  const safeName = String(name || 'renderer').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  let snapshot = {};
  if (browserWindow && !browserWindow.isDestroyed() && !browserWindow.webContents.isDestroyed()) {
    const screenshotPath = path.join(artifactDir, `${safeName}-failure.png`);
    try { await fsp.writeFile(screenshotPath, (await browserWindow.capturePage()).toPNG()); } catch {}
    snapshot = await browserWindow.webContents.executeJavaScript(`(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      activeElement: document.activeElement?.id || document.activeElement?.getAttribute?.('name') || '',
      text: document.body?.innerText?.slice(0, 12000) || '',
      html: document.documentElement?.outerHTML?.slice(0, 40000) || '',
      state: (() => { try { return (${stateExpression}); } catch (error) { return { diagnosticStateError: String(error) }; } })(),
    }))()`).catch((snapshotError) => ({ snapshotError: String(snapshotError?.stack || snapshotError) }));
  }
  const payload = redactDiagnosticValue({
    schemaVersion: 1,
    runId: process.env.JANUS_TEST_RUN_ID || '',
    caseId: process.env.JANUS_TEST_CASE_ID || '',
    capturedAt: new Date().toISOString(),
    error: diagnosticError(error),
    snapshot,
  });
  const jsonPath = path.join(artifactDir, `${safeName}-failure.json`);
  await fsp.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return jsonPath;
}
