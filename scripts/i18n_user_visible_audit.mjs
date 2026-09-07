import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { translateUiText } from '../src/renderer/app/i18n.js';
import { followerI18nContract } from '../src/renderer/app/features/follower/i18n/index.js';
import { ENGLISH_RELEASES } from '../src/renderer/app/views/releaseNotesView.js';
import { RELEASE_ANNOUNCEMENTS } from '../src/shared/releaseAnnouncements.js';

const HAN = /[\u3400-\u9fff]/;
const STRING_LITERAL = /'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])*"/g;
const RENDERER_GLUE_ALLOWLIST = new Set(['的', '的 uBuddy']);

const rendererFiles = sourceFiles('src/renderer', ['*.js', '*.html'])
  .filter((file) => file !== 'src/renderer/app/i18n.js'
    && file !== 'src/renderer/app/features/follower/i18n/zh-CN.js');
const rendererLeaks = untranslatedLiterals(rendererFiles, {
  accept(value, sourceLine) {
    return !value.includes('<') && !value.includes('${') && !RENDERER_GLUE_ALLOWLIST.has(value.trim())
      && !hasExplicitEnglishPair(sourceLine, value);
  },
});
const dynamicRendererLeaks = untranslatedDynamicDomAssignments(rendererFiles);

const mainFiles = sourceFiles(['src/main', 'src/shared', 'network'], ['*.js'])
  .filter((file) => !file.endsWith('/uiLanguage.js') && !file.endsWith('/releaseAnnouncements.js'));
const mainLeaks = untranslatedLiterals(mainFiles, {
  accept(value, sourceLine) {
    return /(?:title|message|detail|subtitle|label|throw new Error|apiError)\s*:|throw new Error|apiError/.test(sourceLine)
      && !hasExplicitEnglishPair(sourceLine, value);
  },
});

const releaseVersions = RELEASE_ANNOUNCEMENTS.map((item) => String(item.version || ''));
assert.deepEqual(Object.keys(ENGLISH_RELEASES), releaseVersions, 'English release-note coverage must match bundled release announcements.');
for (const [version, announcement] of Object.entries(ENGLISH_RELEASES)) {
  assert.equal(HAN.test(JSON.stringify(announcement)), false, `English release notes contain Chinese for ${version}.`);
}

const followerI18n = followerI18nContract();
assert.deepEqual(
  Object.keys(followerI18n.bundles.en).sort(),
  Object.keys(followerI18n.bundles['zh-CN']).sort(),
  'Follower English and Chinese bundles must expose the same keys.',
);
assert.deepEqual(
  Object.keys(followerI18n.bundles.en).sort(),
  [...followerI18n.keys].sort(),
  'Follower bundle keys must match its public i18n contract.',
);
assert.equal(HAN.test(JSON.stringify(followerI18n.bundles.en)), false, 'Follower English bundle contains Chinese.');

const modelServiceCopy = new Map([
  ['Janus 已完成模型服务配置，可直接使用', 'Janus has configured the model service and it is ready to use.'],
  ['自定义 Provider', 'Custom Provider'],
  ['如需使用自己的模型服务，请在下方填写 config.toml 和 auth.json；保存并测试通过后生效。自定义 Provider 不受 Janus Token 限额。', 'To use your own model service, enter config.toml and auth.json below. The custom Provider takes effect after the files are saved and pass the connection test, and is not subject to Janus token limits.'],
  ['如需使用自己的模型服务，请填写 config.toml 和 auth.json，保存并测试通过后生效', 'To use your own model service, fill in config.toml and auth.json. Your configuration will take effect after it is saved and passes the connection test.'],
  ['当前继续使用默认模型服务。', 'Continue using the default model service.'],
  ['Provider 不提供模型 custom-model；当前继续使用默认模型服务。', 'The Provider does not offer model custom-model. The custom Provider was not enabled; Janus will continue using the default model service.'],
  ['网络、鉴权和模型 custom-model 路由检查通过。', 'Network access, authentication, and routing for model custom-model passed.'],
  ['模型：custom-model · 认证变量：CUSTOM_API_KEY · API 地址：https://provider.example/v1', 'Model: custom-model · Authentication variable: CUSTOM_API_KEY · API endpoint: https://provider.example/v1'],
  ['Provider Responses API 拒绝 API Key（HTTP 401）。 当前继续使用默认模型服务。', 'The Provider Responses API rejected the API key (HTTP 401). The custom Provider was not enabled; Janus will continue using the default model service.'],
]);
for (const [source, expected] of modelServiceCopy) {
  assert.equal(translateUiText(source, 'en'), expected, `English model-service copy mismatch for: ${source}`);
}

const taskStageCopy = new Map([
  ['任务已收到', 'Task Received'],
  ['正在整理任务要求', 'Organizing task requirements'],
  ['正在准备隔离工作区', 'Preparing the isolated workspace'],
]);
for (const [source, expected] of taskStageCopy) {
  assert.equal(translateUiText(source, 'en'), expected, `English task-stage copy mismatch for: ${source}`);
}

assert.deepEqual(rendererLeaks, [], formatLeaks('renderer', rendererLeaks));
assert.deepEqual(dynamicRendererLeaks, [], formatLeaks('dynamic renderer DOM assignment', dynamicRendererLeaks));
assert.deepEqual(mainLeaks, [], formatLeaks('main-process user-visible', mainLeaks));
process.stdout.write('User-visible i18n audit passed.\n');

function sourceFiles(roots, globs) {
  const args = ['--files', ...(Array.isArray(roots) ? roots : [roots])];
  for (const glob of globs) args.push('-g', glob);
  args.push('-g', '!*.bak-*', '-g', '!*.orig');
  return execFileSync('rg', args, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

function untranslatedLiterals(files, { accept }) {
  const rows = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    for (const match of source.matchAll(STRING_LITERAL)) {
      const value = decodeLiteral(match[0]);
      if (!HAN.test(value) || !HAN.test(translateUiText(value, 'en'))) continue;
      const line = source.slice(0, match.index).split('\n').length;
      if (!accept(value, lines[line - 1] || '')) continue;
      rows.push(`${file}:${line}: ${value.replace(/\s+/g, ' ').trim()}`);
    }
  }
  return [...new Set(rows)].sort();
}

function untranslatedDynamicDomAssignments(files) {
  const rows = [];
  for (const file of files) {
    if (file === 'src/renderer/recovery/app.js') continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((sourceLine, index) => {
      if (!HAN.test(sourceLine)) return;
      const mutatesVisibleDom = /\.textContent\s*=|\.innerText\s*=|\.setAttribute\(\s*['"](?:title|aria-label|placeholder)['"]/.test(sourceLine);
      if (!mutatesVisibleDom || /translate(?:UiText|Text)\s*\(/.test(sourceLine)) return;
      rows.push(`${file}:${index + 1}: ${sourceLine.trim()}`);
    });
  }
  return rows.sort();
}

function decodeLiteral(raw) {
  return raw.slice(1, -1)
    .replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g,
      (_match, wide, short, hex) => String.fromCodePoint(parseInt(wide || short || hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(['"\\])/g, '$1');
}

function hasExplicitEnglishPair(sourceLine = '', chineseValue = '') {
  const line = String(sourceLine || '');
  if (!line || !HAN.test(chineseValue)) return false;
  const literals = [...line.matchAll(STRING_LITERAL)].map((match) => decodeLiteral(match[0]));
  const hasEnglishLiteral = literals.some((value) => value !== chineseValue
    && !HAN.test(value)
    && /[A-Za-z]/.test(value));
  if (!hasEnglishLiteral) return false;
  return /\bt\s*\(/.test(line)
    || /\b(?:english|isEnglishUi\(\)|languageMode\s*===\s*['"]en['"])\s*\?/.test(line)
    || /\{\s*zh\s*:/.test(line) && /\ben\s*:/.test(line);
}

function formatLeaks(area, rows) {
  return rows.length ? `Untranslated ${area} strings:\n${rows.join('\n')}` : '';
}
