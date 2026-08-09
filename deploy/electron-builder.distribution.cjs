const fs = require('node:fs');
const path = require('node:path');

module.exports = function applyDistributionProfile(sourceBuild, { projectRoot } = {}) {
  const build = sourceBuild;
  const root = path.resolve(projectRoot || path.join(__dirname, '..'));
  const mode = distributionMode(process.env.JANUS_DISTRIBUTION_MODE);
  const appId = value('JANUS_DESKTOP_APP_ID', build.appId || 'org.example.janus');
  const productName = value('JANUS_DESKTOP_PRODUCT_NAME', build.productName || 'Janus');
  const executableName = value('JANUS_DESKTOP_EXECUTABLE_NAME', productName);
  const updateUrl = value('JANUS_DESKTOP_UPDATE_URL', '').replace(/\/+$/g, '');
  const signingPublicKey = value('JANUS_DESKTOP_SIGNING_PUBLIC_KEY_FILE', '');

  build.appId = appId;
  build.productName = productName;
  build.executableName = executableName;
  build.extraMetadata = {
    ...(build.extraMetadata || {}),
    productName,
    janusDistributionMode: mode,
  };
  if (updateUrl) build.publish = [{ provider: 'generic', url: updateUrl }];
  else delete build.publish;

  if (signingPublicKey) {
    const resolved = path.resolve(signingPublicKey);
    if (!fs.existsSync(resolved)) {
      throw new Error(`JANUS_DESKTOP_SIGNING_PUBLIC_KEY_FILE does not exist: ${resolved}`);
    }
    build.extraResources = [
      ...(build.extraResources || []),
      { from: resolved, to: 'app.asar.unpacked/assets/release-signing-public.pem' },
    ];
  }
  return build;
};

function distributionMode(raw = '') {
  const mode = String(raw || '').trim().toLowerCase();
  if (!mode || mode === 'community' || mode === 'open-source') return 'community';
  if (mode === 'official' || mode === 'internal-embedded') return 'official';
  throw new Error(`JANUS_DISTRIBUTION_MODE must be community or official, received ${mode}.`);
}

function value(name, fallback = '') {
  const configured = String(process.env[name] || '').trim();
  return configured || String(fallback || '').trim();
}
