const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const tempRoot = mkdtempSync(path.join(tmpdir(), 'janus-account-menu-style-'));
const htmlPath = path.join(tempRoot, 'index.html');
const baseCss = pathToFileURL(path.join(process.cwd(), 'src/renderer/styles/base.css')).href;
const chatCss = pathToFileURL(path.join(process.cwd(), 'src/renderer/styles/chat.css')).href;

writeFileSync(htmlPath, `<!doctype html>
<html data-platform="linux">
  <head>
    <link rel="stylesheet" href="${baseCss}">
    <link rel="stylesheet" href="${chatCss}">
  </head>
  <body>
    <div class="account-menu">
      <a class="account-menu-item" href="#settings"><span></span><strong>Settings</strong></a>
      <button class="account-menu-item" type="button"><span></span><strong>Sign Out</strong></button>
    </div>
  </body>
</html>`);

let window;

app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  await window.loadFile(htmlPath);
  const styles = await window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const read = (item) => {
      const itemStyle = getComputedStyle(item);
      const labelStyle = getComputedStyle(item.querySelector('strong'));
      return {
        appearance: itemStyle.appearance,
        fontFamily: itemStyle.fontFamily,
        fontSize: itemStyle.fontSize,
        fontWeight: itemStyle.fontWeight,
        lineHeight: itemStyle.lineHeight,
        letterSpacing: itemStyle.letterSpacing,
        padding: itemStyle.padding,
        labelFontFamily: labelStyle.fontFamily,
        labelFontSize: labelStyle.fontSize,
        labelFontWeight: labelStyle.fontWeight,
        labelLineHeight: labelStyle.lineHeight,
      };
    };
    return Object.fromEntries(['darwin', 'win32', 'linux'].map((platform) => {
      root.dataset.platform = platform;
      return [platform, {
        menuFontFamily: getComputedStyle(document.querySelector('.account-menu')).fontFamily,
        items: [...document.querySelectorAll('.account-menu-item')].map(read),
      }];
    }));
  })()`);

  for (const [platform, result] of Object.entries(styles)) {
    assert.equal(result.items.length, 2, `${platform} should render both account actions`);
    assert.equal(result.items[0].appearance, 'none', `${platform} should reset native button appearance`);
    assert.deepEqual(result.items[0], result.items[1], `${platform} link and button styles diverged`);
    assert.equal(result.items[0].labelFontWeight, '500', `${platform} labels should use the menu font weight`);
  }
  assert.match(styles.darwin.menuFontFamily, /PingFang SC/, 'macOS did not select its UI font stack');
  assert.match(styles.win32.menuFontFamily, /Segoe UI/, 'Windows did not select its UI font stack');
  assert.match(styles.linux.menuFontFamily, /Noto Sans CJK SC/, 'Linux did not select its UI font stack');
  process.stdout.write('Account menu platform style smoke passed.\n');
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
}).finally(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

app.on('window-all-closed', () => {});
