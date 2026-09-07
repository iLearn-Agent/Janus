#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverUrl = String(process.env.JANUS_PACKAGED_CLOUD_URL || '').trim().replace(/\/+$/, '');

if (!/^https?:\/\/[^\s/$.?#].*$/i.test(serverUrl)) {
  throw new Error('JANUS_PACKAGED_CLOUD_URL must be a valid HTTP(S) URL.');
}

const target = path.join(projectRoot, 'assets', 'cloud-sync-defaults.json');
fs.writeFileSync(target, `${JSON.stringify({ serverUrl, autoSync: true }, null, 2)}\n`, { mode: 0o600 });
console.log('Packaged cloud sync defaults are ready.');
