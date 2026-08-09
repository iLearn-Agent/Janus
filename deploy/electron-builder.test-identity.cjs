const { spawnSync } = require('node:child_process');

module.exports = function applyTestReleaseIdentity(sourceBuild, { output, artifactName } = {}) {
  const beforePack = sourceBuild.beforePack;
  const build = structuredClone({ ...sourceBuild, beforePack: undefined });
  if (beforePack) {
    build.beforePack = async (context) => {
      const previousRequired = process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
      const official = ['official', 'internal-embedded'].includes(String(process.env.JANUS_DISTRIBUTION_MODE || '').trim().toLowerCase());
      if (official) process.env.JANUS_TRIAL_PROVIDER_REQUIRED = '1';
      else delete process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
      try {
        await beforePack(context);
      } finally {
        if (previousRequired === undefined) delete process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
        else process.env.JANUS_TRIAL_PROVIDER_REQUIRED = previousRequired;
      }
    };
  }
  build.appId = String(process.env.JANUS_TEST_DESKTOP_APP_ID || 'local.janus.desktop.test').trim();
  build.productName = String(process.env.JANUS_TEST_DESKTOP_PRODUCT_NAME || 'Janus Test').trim();
  build.executableName = build.productName;
  build.artifactName = artifactName;
  build.extraMetadata = {
    ...(build.extraMetadata || {}),
    name: String(process.env.JANUS_TEST_DESKTOP_PACKAGE_NAME || 'janus-test').trim(),
    productName: build.productName,
    janusDesktopReleaseChannel: 'test',
    janusSourceCommit: sourceIdentity('JANUS_SOURCE_COMMIT', ['rev-parse', 'HEAD']),
    janusSourceTree: sourceIdentity('JANUS_SOURCE_TREE', ['rev-parse', 'HEAD^{tree}']),
  };
  const updateUrl = String(process.env.JANUS_TEST_UPDATE_URL || '').trim().replace(/\/+$/g, '');
  if (updateUrl) build.publish = [{ provider: 'generic', url: updateUrl, channel: 'latest' }];
  else delete build.publish;
  build.detectUpdateChannel = false;
  build.directories = {
    ...(build.directories || {}),
    output,
  };
  return build;
};

function sourceIdentity(name, gitArgs) {
  const configured = String(process.env[name] || '').trim();
  if (configured) return configured;
  const result = spawnSync('git', gitArgs, { encoding: 'utf8', windowsHide: true });
  const value = String(result.stdout || '').trim();
  if (result.status === 0 && value) return value;
  throw new Error(`Test packages require ${name} or a Git checkout with a resolvable source identity.`);
}
