#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  promoteUnifiedDesktopFeeds,
  unifiedDesktopReleaseReadiness,
} from '../src/shared/unifiedDesktopRelease.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-release-platform-'));
const releases = path.join(root, 'releases');
const version = '0.2.4';

try {
  writeFeed('windows', 'latest.yml', 'Janus Setup 0.2.4.exe');
  let readiness = unifiedDesktopReleaseReadiness(root, version);
  assert.deepEqual(readiness.available, ['windows']);
  assert.deepEqual(readiness.missing, ['macos', 'linux']);

  let promotion = await promoteUnifiedDesktopFeeds(root, version);
  assert.equal(promotion.status, 'partially_promoted');
  assert.deepEqual(promotion.promoted, ['windows']);
  assert.equal(fs.readlinkSync(path.join(releases, 'windows', 'latest.yml')), '0.2.4/latest.yml');
  assert.match(fs.readFileSync(path.join(releases, 'latest.yml'), 'utf8'), /windows\/0\.2\.4\/Janus Setup 0\.2\.4\.exe/);

  writeFeed('linux', 'latest-linux.yml', 'Janus-0.2.4.AppImage');
  readiness = unifiedDesktopReleaseReadiness(root, version);
  assert.deepEqual(readiness.available, ['windows', 'linux']);
  assert.deepEqual(readiness.missing, ['macos']);

  promotion = await promoteUnifiedDesktopFeeds(root, version);
  assert.equal(promotion.status, 'partially_promoted');
  assert.deepEqual(promotion.promoted, ['windows', 'linux']);
  assert.equal(fs.readlinkSync(path.join(releases, 'linux', 'latest-linux.yml')), '0.2.4/latest-linux.yml');
  assert.match(fs.readFileSync(path.join(releases, 'latest-linux.yml'), 'utf8'), /linux\/0\.2\.4\/Janus-0\.2\.4\.AppImage/);

  assert.equal(fs.existsSync(path.join(releases, 'macos', 'latest-mac.yml')), false);
  console.log('release platform compatibility smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeFeed(platform, feed, artifact) {
  const directory = path.join(releases, platform, version);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, feed), [
    `version: ${version}`,
    'files:',
    `  - url: ${version}/${artifact}`,
    '    sha512: test',
    '    size: 1',
    `path: ${version}/${artifact}`,
    'sha512: test',
    '',
  ].join('\n'), 'utf8');
}
