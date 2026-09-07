import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { applyAgentBundle, readInstalledAgentBundle, rollbackAgentBundle, validateAgentBundle, verifyAgentBundleSignature } from '../shared/agentBundle.js';
import { sendWebContentsSafely } from '../shared/electronProcessSafety.js';
import { getApplicationLogger } from '../shared/logging/index.js';
import { assetRoot } from './paths.js';

const DEFAULT_UPDATE_URL = 'http://your-janus.example/janus/releases';
const agentBundleLogger = getApplicationLogger('agent-bundles');

export function createAgentBundleService({ root, appVersion = '', windowProvider, fetchImpl = globalThis.fetch, autoApply = true, channel: requestedChannel = '', onStatusChanged = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Agent update network client is unavailable.');
  const channel = requestedChannel || process.env.JANUS_AGENT_UPDATE_CHANNEL || 'stable';
  const apiUrl = releaseApiUrl();
  const cacheDir = path.join(root, '.janus', 'agent-bundles', 'downloads');
  const signingPublicKeyPath = process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY || path.join(assetRoot, 'release-signing-public.pem');
  const state = {
    enabled: !falsey(process.env.JANUS_AGENT_UPDATES_ENABLED),
    channel,
    apiUrl,
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    applying: false,
    current: readInstalledAgentBundle(root),
    candidate: null,
    downloadedPath: '',
    lastCheckAt: '',
    lastError: '',
    failureStage: '',
    message: 'Agent updates are ready.',
  };

  const sendStatus = () => {
    const win = windowProvider?.();
    sendWebContentsSafely(win, 'agent-updates:status', publicState(state));
  };
  const setState = (patch) => {
    const previous = publicState(state);
    Object.assign(state, patch);
    sendStatus();
    const current = publicState(state);
    try { onStatusChanged?.({ current, previous, patch: { ...patch } }); } catch {}
    return current;
  };

  return {
    status() {
      state.current = readInstalledAgentBundle(root);
      return publicState(state);
    },
    async checkNow() {
      if (!state.enabled) return setState({ message: 'Agent updates are disabled.' });
      if (state.checking) return publicState(state);
      setState({ checking: true, lastCheckAt: new Date().toISOString(), lastError: '', failureStage: '', message: 'Checking for Agent updates.' });
      agentBundleLogger.info('agent-bundle-check-started', { data: { channel } });
      try {
        const params = new URLSearchParams({ channel, platform: process.platform, arch: process.arch, kind: 'agent_bundle' });
        const response = await fetchImpl(`${apiUrl}/v1/releases/latest?${params.toString()}`, { headers: { accept: 'application/json' } });
        const detail = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 404) return setState({ checking: false, available: false, candidate: null, message: 'No Agent update is published.' });
          throw new Error(detail.error || `Release API returned ${response.status}`);
        }
        const manifest = detail.manifest || {};
        const artifact = (manifest.artifacts || []).find((item) => item.kind === 'agent_bundle');
        if (!artifact) return setState({ checking: false, available: false, candidate: null, message: 'The latest release has no Agent bundle.' });
        if (artifact.minAppVersion && compareVersions(appVersion, artifact.minAppVersion) < 0) {
          return setState({
            checking: false,
            available: false,
            candidate: { manifest, artifact, incompatible: true },
            message: `Agent update requires Janus ${artifact.minAppVersion} or newer.`,
          });
        }
        const currentId = state.current?.bundleId || '';
        const releaseVersion = artifact.releaseVersion || manifest.version || '';
        const available = Boolean(artifact.bundleId && artifact.bundleId !== currentId);
        const result = setState({
          checking: false,
          available,
          downloaded: state.downloaded && state.candidate?.artifact?.bundleId === artifact.bundleId,
          candidate: { manifest, artifact, release: detail },
          lastCheckAt: new Date().toISOString(),
          message: available ? `Janus ${releaseVersion || artifact.bundleId} is available and will be applied automatically.` : 'Janus is up to date.',
        });
        agentBundleLogger.info('agent-bundle-check-completed', { data: { channel, available, releaseVersion } });
        if (!available || !autoApply) return result;
        const downloaded = await this.downloadNow();
        return downloaded.downloaded ? this.applyNow() : downloaded;
      } catch (error) {
        agentBundleLogger.error('agent-bundle-check-failed', { data: { channel }, error });
        return setState({ checking: false, lastError: String(error.message || error), failureStage: 'check', message: 'Agent update check failed.' });
      }
    },
    async downloadNow() {
      const artifact = state.candidate?.artifact;
      if (!state.available || !artifact) return setState({ message: 'No Agent update is available to download.' });
      if (state.downloading) return publicState(state);
      const releaseVersion = artifact.releaseVersion || state.candidate?.manifest?.version || '';
      setState({ downloading: true, lastError: '', failureStage: '', message: `Downloading Janus ${releaseVersion || artifact.bundleId || 'Agent update'}.` });
      try {
        const artifactUrl = new URL(artifact.url, `${apiUrl}/`).toString();
        const response = await fetchImpl(artifactUrl, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`Agent bundle download failed (${response.status}).`);
        const text = await response.text();
        const actualArtifactHash = crypto.createHash('sha256').update(text).digest('hex');
        if (artifact.sha256 && artifact.sha256 !== actualArtifactHash) throw new Error('Agent bundle artifact checksum mismatch.');
        const bundle = JSON.parse(text);
        validateAgentBundle(bundle, { expectedSha256: artifact.sha256 || '' });
        if (releaseVersion && bundle.releaseVersion !== releaseVersion) throw new Error('Agent release version does not match its manifest.');
        if (!fs.existsSync(signingPublicKeyPath)) throw new Error('Trusted Agent release public key is missing from this application.');
        verifyAgentBundleSignature(bundle, { publicKeyPem: fs.readFileSync(signingPublicKeyPath, 'utf8') });
        fs.mkdirSync(cacheDir, { recursive: true });
        const downloadPath = path.join(cacheDir, `${bundle.bundleId}.json`);
        fs.writeFileSync(downloadPath, text, 'utf8');
        return setState({
          downloading: false,
          downloaded: true,
          downloadedPath: downloadPath,
          message: `Janus ${bundle.releaseVersion} downloaded and verified.`,
        });
      } catch (error) {
        agentBundleLogger.error('agent-bundle-download-failed', { data: { channel, releaseVersion }, error });
        return setState({ downloading: false, downloaded: false, lastError: String(error.message || error), failureStage: 'download', message: 'Agent update download failed.' });
      }
    },
    applyNow() {
      if (!state.downloaded || !state.downloadedPath || !fs.existsSync(state.downloadedPath)) {
        return setState({ message: 'No downloaded Agent update is ready to apply.' });
      }
      setState({ applying: true, lastError: '', failureStage: '', message: 'Applying Agent update.' });
      try {
        const bundle = JSON.parse(fs.readFileSync(state.downloadedPath, 'utf8'));
        const installed = applyAgentBundle({ root, bundle });
        return setState({
          applying: false,
          available: false,
          downloaded: false,
          current: installed,
          message: `Agent 组织 ${installed.releaseVersion} 已应用，新对话将使用更新后的组织配置。`,
        });
      } catch (error) {
        agentBundleLogger.error('agent-bundle-apply-failed', { data: { channel }, error });
        return setState({ applying: false, lastError: String(error.message || error), failureStage: 'apply', message: 'Agent update apply failed; previous files were restored.' });
      }
    },
    rollbackNow() {
      setState({ lastError: '', failureStage: '', message: 'Rolling back Agent update.' });
      try {
        const result = rollbackAgentBundle({ root });
        return setState({ current: null, available: Boolean(state.candidate), lastError: '', failureStage: '', message: `Rolled back Janus ${result.rolledBackReleaseVersion || result.rolledBackBundleId}.` });
      } catch (error) {
        agentBundleLogger.error('agent-bundle-rollback-failed', { data: { channel }, error });
        return setState({ lastError: String(error.message || error), failureStage: 'rollback', message: 'Agent update rollback failed.' });
      }
    },
    scheduleInitialCheck(delayMs = 0) {
      if (!state.enabled) return;
      setTimeout(() => this.checkNow().catch(() => null), delayMs);
    },
  };
}

function releaseApiUrl() {
  const explicit = String(process.env.JANUS_RELEASE_API_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/g, '');
  const updateUrl = String(process.env.JANUS_UPDATE_URL || DEFAULT_UPDATE_URL);
  try {
    return new URL(updateUrl).origin;
  } catch {
    return 'http://your-janus.example';
  }
}

function publicState(state) {
  return {
    enabled: state.enabled,
    channel: state.channel,
    apiUrl: state.apiUrl,
    checking: state.checking,
    available: state.available,
    downloading: state.downloading,
    downloaded: state.downloaded,
    applying: state.applying,
    current: state.current,
    candidate: state.candidate,
    lastCheckAt: state.lastCheckAt,
    lastError: state.lastError,
    failureStage: state.failureStage,
    message: state.message,
  };
}

function compareVersions(left, right) {
  const a = String(left || '0').split(/[.+-]/).map((part) => Number(part) || 0);
  const b = String(right || '0').split(/[.+-]/).map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function falsey(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').toLowerCase());
}
