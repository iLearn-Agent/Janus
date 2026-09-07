const { spawnSync } = require('node:child_process');

module.exports = function applyTestReleaseIdentity(sourceBuild, { output, artifactName } = {}) {
  const beforePack = sourceBuild.beforePack;
  const build = structuredClone({ ...sourceBuild, beforePack: undefined });
  if (beforePack) {
    build.beforePack = async (context) => {
      const previousRequired = process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
      const internalEmbedded = String(process.env.JANUS_DISTRIBUTION_MODE || '').trim().toLowerCase() === 'open-source';
      if (internalEmbedded) process.env.JANUS_TRIAL_PROVIDER_REQUIRED = '1';
      else delete process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
      try {
        await beforePack(context);
      } finally {
        if (previousRequired === undefined) delete process.env.JANUS_TRIAL_PROVIDER_REQUIRED;
        else process.env.JANUS_TRIAL_PROVIDER_REQUIRED = previousRequired;
      }
    };
  }
  build.appId = 'local.janus.desktop.test';
  build.productName = 'Janus Test';
  build.executableName = 'Janus Test';
  build.artifactName = artifactName;
  build.extraMetadata = {
    ...(build.extraMetadata || {}),
    name: 'janus-test',
    productName: 'Janus Test',
    janusDesktopReleaseChannel: 'test',
    janusSourceCommit: sourceIdentity('JANUS_SOURCE_COMMIT', ['rev-parse', 'HEAD']),
    janusSourceTree: sourceIdentity('JANUS_SOURCE_TREE', ['rev-parse', 'HEAD^{tree}']),
  };
  build.publish = [{
    provider: 'generic',
    url: 'http://your-janus.example/janus/test_releases',
    channel: 'latest',
  }];
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
