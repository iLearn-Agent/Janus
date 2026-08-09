const packageJson = require('../package.json');
const path = require('node:path');
const applyTrialProviderBundle = require('./electron-builder.trial-provider.cjs');
const applyDistributionProfile = require('./electron-builder.distribution.cjs');

const build = structuredClone(packageJson.build || {});
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
  'node_modules/@openai/codex-linux-x64/**/*',
  'src/main/ppt_service/**/*',
];
build.electronLanguages = ['en', 'zh_CN'];
build.files = [
  'src/**/*',
  'network/**/*',
  'assets/**/*',
  'node_modules/@openai/codex/**/*',
  'node_modules/@openai/codex-linux-x64/**/*',
  'package.json',
  '!node_modules/@openai/codex-darwin-*/**/*',
  '!node_modules/@openai/codex-win32-*/**/*',
  '!**/*.bak-*',
  '!**/*.orig',
  '!**/__pycache__/**',
  '!**/*.pyc',
  '!**/*.pyo',
];

module.exports = applyDistributionProfile(applyTrialProviderBundle(build, { projectRoot }), { projectRoot });
