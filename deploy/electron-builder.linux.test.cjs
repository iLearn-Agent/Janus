const applyTestReleaseIdentity = require('./electron-builder.test-identity.cjs');

module.exports = applyTestReleaseIdentity(require('./electron-builder.linux.cjs'), {
  output: 'test-artifacts/linux',
  artifactName: '${productName}-${version}.${ext}',
});
