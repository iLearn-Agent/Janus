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

// A checked-in electronDist points at the runner's host architecture only.
// Universal builds must let electron-builder download both x64 and arm64
// Electron distributions independently before merging them.
delete build.electronDist;

build.asar = true;
build.asarUnpack = [
  'assets/**/*',
  'node_modules/@openai/codex/**/*',
  'node_modules/@openai/codex-darwin-arm64/**/*',
  'src/main/ppt_service/**/*',
];
// macOS Electron distributions store locales as en.lproj and zh_CN.lproj.
build.electronLanguages = ['en', 'zh_CN'];
build.files = [
  'src/**/*',
  'network/**/*',
  'assets/**/*',
  'node_modules/@openai/codex/**/*',
  'node_modules/@openai/codex-darwin-arm64/**/*',
  'package.json',
  '!node_modules/@openai/codex-linux-*/**/*',
  '!node_modules/@openai/codex-win32-*/**/*',
  '!**/*.bak-*',
  '!**/*.orig',
  '!**/__pycache__/**',
  '!**/*.pyc',
  '!**/*.pyo',
];

module.exports = applyDistributionProfile(applyTrialProviderBundle(build, { projectRoot }), { projectRoot });
