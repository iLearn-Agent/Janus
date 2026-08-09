const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = function applyTrialProviderBundle(sourceBuild, { projectRoot } = {}) {
  const root = path.resolve(projectRoot || path.join(__dirname, '..'));
  const build = sourceBuild;
  const priorBeforePack = build.beforePack;
  build.extraResources = [
    ...(build.extraResources || []),
    {
      from: path.join(root, 'build-runtime', 'trial-provider', 'provider.enc'),
      to: 'trial-provider/provider.enc',
    },
  ];
  build.beforePack = async (context) => {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'prepare_trial_provider_bundle.mjs'),
      '--root', root,
    ], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Trial Provider bundle preparation exited with code ${result.status}`);
    if (priorBeforePack) await priorBeforePack(context);
  };
  return build;
};
