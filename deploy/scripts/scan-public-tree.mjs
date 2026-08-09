#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(argumentValue('--root', process.cwd()));
const failures = [];
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'out', 'workspace', 'data', 'test-artifacts', 'build-runtime']);
const forbiddenFile = /(?:^|\/)(?:\.env(?:\..+)?|.*(?:private|secret)[-_].*\.pem|.*\.(?:db|sqlite|sqlite3|dump|p12|pfx|key|bak|orig))$/i;
const forbiddenText = [
  { name: 'private key', pattern: new RegExp(`-----BEGIN (?:RSA |EC |OPENSSH )?${'PRIVATE'} KEY-----`) },
  { name: 'production host path', pattern: /\/home\/ubuntu(?:\/|\b)/ },
  { name: 'historical official IPv4 address', pattern: /\b123\.207\.22\.235\b/ },
  { name: 'SSH private key', pattern: new RegExp(`BEGIN OPENSSH ${'PRIVATE'} KEY`) },
];

walk(root);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Public-tree scan passed: ${root}\n`);

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    const relative = path.relative(root, filename).replaceAll(path.sep, '/');
    if (entry.isDirectory()) walk(filename);
    else if (entry.isFile()) inspect(filename, relative);
  }
}

function inspect(filename, relative) {
  if (relative === 'deploy/scripts/scan-public-tree.mjs') return;
  if (forbiddenFile.test(relative) && !relative.endsWith('.example')) failures.push(`${relative}: forbidden private/runtime filename.`);
  const stat = fs.statSync(filename);
  if (stat.size > 2 * 1024 * 1024) return;
  const buffer = fs.readFileSync(filename);
  if (buffer.includes(0)) return;
  const text = buffer.toString('utf8');
  for (const check of forbiddenText) if (check.pattern.test(text)) failures.push(`${relative}: contains ${check.name}.`);
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] || fallback;
}
