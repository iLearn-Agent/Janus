import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { browseProjectFileReferences } from '../src/main/modules/projects/application/projectFileReferences.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'janus-project-mention-'));
const project = { id: 'project-mention-smoke', userId: 'user-smoke', workspaceId: 'workspace_personal', title: 'Mention Smoke', workspaceRoot: root };
const store = {
  getProject: (projectId) => projectId === project.id ? project : null,
  activeAccountWorkspace: () => ({ id: 'workspace_personal' }),
  contextDeviceId: () => 'smoke-device',
};

try {
  mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'hidden-package'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# mention smoke\n');
  writeFileSync(path.join(root, 'src', 'app.js'), 'export const app = true;\n');
  writeFileSync(path.join(root, 'src', 'renderer', 'panel.js'), 'export const panel = true;\n');
  writeFileSync(path.join(root, 'node_modules', 'hidden-package', 'panel-secret.js'), 'hidden\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=hidden\n');

  const browse = (payload = {}) => browseProjectFileReferences({
    store,
    user: { id: 'user-smoke' },
    projectId: project.id,
    canonicalizeWorkspace: (workspaceRoot) => realpathSync(workspaceRoot),
    ...payload,
  });

  const rootEntries = browse();
  assert.deepEqual(rootEntries.entries.map((entry) => entry.relativePath), ['src', 'README.md']);
  assert.equal(rootEntries.entries.some((entry) => entry.relativePath.includes('panel.js')), false,
    'An empty query should keep the explorer at one directory level.');

  const panelMatches = browse({ query: 'pan' });
  assert.equal(panelMatches.entries[0]?.relativePath, 'src/renderer/panel.js',
    'Typing a filename prefix should find nested project files without opening folders first.');
  assert.equal(panelMatches.entries.some((entry) => entry.relativePath.includes('node_modules')), false,
    'Recursive autocomplete must preserve hidden/generated directory exclusions.');

  const appMatches = browse({ query: 'app' });
  assert.equal(appMatches.entries[0]?.relativePath, 'src/app.js');
  assert.equal(appMatches.entries.some((entry) => entry.relativePath === '.env'), false,
    'Sensitive filenames must remain excluded from autocomplete.');

  console.log('project mention autocomplete smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
