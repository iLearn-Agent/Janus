import assert from 'node:assert/strict';
import fs from 'node:fs';

import { followerI18nContract } from '../../src/renderer/app/features/follower/i18n/index.js';

const { keys, bundles } = followerI18nContract();
assert.deepEqual(Object.keys(bundles['zh-CN']).sort(), [...keys].sort());
assert.deepEqual(Object.keys(bundles.en).sort(), [...keys].sort());
for (const key of keys) {
  const placeholders = (value) => [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
  assert.deepEqual(placeholders(bundles['zh-CN'][key]), placeholders(bundles.en[key]), `placeholder mismatch: ${key}`);
}
for (const file of [
  'src/renderer/app/features/follower/followerView.js',
  'src/renderer/app/features/follower/followerController.js',
]) {
  const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, />[\u3400-\u9fff][^<{]*</u, `visible Chinese literal in ${file}`);
}
console.log('Follower i18n contract smoke passed');
