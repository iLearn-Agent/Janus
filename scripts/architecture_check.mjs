import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const architectureRoots = [
  'src/main/modules',
  'src/main/platform',
  'src/renderer/app/features',
  'src/renderer/app/platform',
  'src/cloud/modules',
  'cloud/src/modules',
];

const compatibilityEntrypoints = [
  'src/main/main.js',
  'src/main/runtime.js',
  'src/main/store.js',
  'src/main/auth.js',
  'src/main/evolution.js',
  'src/main/scheduler.js',
  'src/main/codex.js',
  'src/main/db.js',
  'src/renderer/app.js',
  'src/preload/preload.js',
  'src/cloud/server.js',
  'cloud/src/server.mjs',
  'network/index.js',
  'src/main/ppt_service/ppt_debug_service.py',
  'src/main/ppt_service/slide_library_renderer.py',
  'src/main/ppt_service/render_ppt.py',
];

for (const entrypoint of compatibilityEntrypoints) {
  assert.ok(fs.existsSync(path.join(root, entrypoint)), `missing compatibility entrypoint: ${entrypoint}`);
}

const sourceExtensions = new Set(['.js', '.mjs', '.cjs']);
const importPattern = /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const relativeRoot of architectureRoots) {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) continue;
  for (const file of walk(absoluteRoot)) validateImports(file);
}

console.log('architecture check passed');

function validateImports(file) {
  if (!sourceExtensions.has(path.extname(file))) return;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] || match[2] || '';
    if (!specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier);
    const normalizedFile = file.split(path.sep).join('/');
    const normalizedTarget = target.split(path.sep).join('/');

    if (normalizedFile.includes('/domain/')) {
      assert.ok(
        !/(\/infrastructure\/|\/platform\/|\/ipc\/|\/bootstrap\/)/.test(normalizedTarget),
        `domain module imports infrastructure: ${relative(file)} -> ${specifier}`,
      );
    }
    if (normalizedFile.includes('/application/')) {
      assert.ok(
        !/(\/infrastructure\/|\/ipc\/|\/bootstrap\/)/.test(normalizedTarget),
        `application module imports concrete infrastructure: ${relative(file)} -> ${specifier}`,
      );
    }

    validateFeatureBoundary(file, target, specifier, '/src/main/modules/');
    validateFeatureBoundary(file, target, specifier, '/src/renderer/app/features/');
    validateFeatureBoundary(file, target, specifier, '/src/cloud/modules/');
    validateFeatureBoundary(file, target, specifier, '/cloud/src/modules/');
  }
}

function validateFeatureBoundary(file, target, specifier, marker) {
  const normalizedFile = file.split(path.sep).join('/');
  const normalizedTarget = target.split(path.sep).join('/');
  if (!normalizedFile.includes(marker) || !normalizedTarget.includes(marker)) return;
  const sourceModule = normalizedFile.split(marker)[1]?.split('/')[0] || '';
  const targetRemainder = normalizedTarget.split(marker)[1] || '';
  const targetModule = targetRemainder.split('/')[0] || '';
  if (!sourceModule || !targetModule || sourceModule === targetModule) return;
  const publicEntry = targetRemainder === targetModule
    || targetRemainder === `${targetModule}/index.js`
    || targetRemainder === `${targetModule}/index.mjs`;
  assert.ok(publicEntry, `module imports another module's internals: ${relative(file)} -> ${specifier}`);
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}
