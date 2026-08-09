const applyTestReleaseIdentity = require('./electron-builder.test-identity.cjs');

module.exports = applyTestReleaseIdentity(require('./electron-builder.macos.cjs'), {
  output: 'test-artifacts/macos',
  artifactName: '${productName}-${version}-${arch}.${ext}',
});
