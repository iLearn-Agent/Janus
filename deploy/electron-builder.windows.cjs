const packageJson = require('../package.json');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const applyTrialProviderBundle = require('./electron-builder.trial-provider.cjs');
const applyDistributionProfile = require('./electron-builder.distribution.cjs');

const build = structuredClone(packageJson.build || {});
const windowsPublisherName = String(process.env.JANUS_WINDOWS_PUBLISHER_NAME || '').trim();
const projectRoot = path.resolve(__dirname, '..');
build.extraMetadata = {
  ...(build.extraMetadata || {}),
  janusSourceCommit: String(process.env.JANUS_SOURCE_COMMIT || '').trim(),
  janusSourceTree: String(process.env.JANUS_SOURCE_TREE || '').trim(),
};
delete build.electronDist;
build.asar = true;
build.asarUnpack = [
  'assets/**/*',
  'node_modules/@openai/codex/**/*',
  'node_modules/@openai/codex-win32-x64/**/*',
  'src/main/ppt_service/**/*',
];
build.extraResources = [
  ...(build.extraResources || []),
  {
    from: path.join(projectRoot, 'build-runtime', 'windows-x64', 'python'),
    to: 'python',
    filter: ['**/*'],
  },
];
build.beforePack = async () => {
  const result = spawnSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'prepare_windows_python_runtime.mjs'),
    '--root', projectRoot,
  ], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows Python runtime preparation exited with code ${result.status}`);
};
// Windows Electron distributions store locales as en-US.pak and zh-CN.pak.
build.electronLanguages = ['en-US', 'zh-CN'];
build.nsis = {
  ...(build.nsis || {}),
  oneClick: false,
  perMachine: false,
  allowToChangeInstallationDirectory: true,
  useZip: false,
  runAfterFinish: true,
  include: 'deploy/installer.windows.nsh',
};
build.win = {
  ...(build.win || {}),
  ...(windowsPublisherName ? { publisherName: windowsPublisherName } : {}),
};
build.files = [
  'src/**/*',
  'network/**/*',
  'assets/**/*',
  'node_modules/@openai/codex/**/*',
  'node_modules/@openai/codex-win32-x64/**/*',
  'package.json',
  '!node_modules/@openai/codex-darwin-*/**/*',
  '!node_modules/@openai/codex-linux-*/**/*',
  '!**/*.bak-*',
  '!**/*.orig',
  '!**/__pycache__/**',
  '!**/*.pyc',
  '!**/*.pyo',
];

module.exports = applyDistributionProfile(applyTrialProviderBundle(build, { projectRoot }), { projectRoot });
