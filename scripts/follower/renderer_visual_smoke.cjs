globalThis.__janusElectron = require('electron');
import('./renderer_visual_smoke.mjs').then(() => {
  globalThis.__janusElectron.app.exit(0);
}).catch((error) => {
  console.error(error);
  globalThis.__janusElectron.app.exit(1);
});
