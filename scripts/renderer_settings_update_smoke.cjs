globalThis.__janusElectron = require('electron');

import('./renderer_settings_update_smoke.mjs').then(() => {
  globalThis.__janusElectron.app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  globalThis.__janusElectron.app.exit(1);
});
