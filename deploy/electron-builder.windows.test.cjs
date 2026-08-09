const applyTestReleaseIdentity = require('./electron-builder.test-identity.cjs');

module.exports = applyTestReleaseIdentity(require('./electron-builder.windows.cjs'), {
  output: 'test-artifacts/windows',
  artifactName: '${productName} Setup ${version}.${ext}',
});
