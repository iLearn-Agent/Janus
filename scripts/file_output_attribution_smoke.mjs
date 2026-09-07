import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectMessageOutputArtifacts, collectTurnChangedFilePaths } from '../src/main/files.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-output-attribution-'));
const workspaceRoot = path.join(root, 'workspace');
fs.mkdirSync(workspaceRoot, { recursive: true });
const generated = path.join(workspaceRoot, 'generated.md');
const inspected = path.join(workspaceRoot, 'inspected.md');
fs.writeFileSync(generated, '# generated');
fs.writeFileSync(inspected, '# inspected');

const changedPaths = collectTurnChangedFilePaths([{ changes: [{ path: generated, kind: 'update' }] }], { workspaceRoot });
assert.equal(changedPaths.has(generated), true);
assert.equal(changedPaths.has(inspected), false);

const artifacts = collectMessageOutputArtifacts(root, [
  '- [生成文件](generated.md)',
  '- [查看过的文件](inspected.md)',
].join('\n'), { workspaceRoot, changedPaths });
assert.deepEqual(artifacts.map((item) => item.name), ['generated.md']);

console.log(JSON.stringify({ ok: true, checks: ['changed_file_intersection', 'inspected_file_excluded'] }));
