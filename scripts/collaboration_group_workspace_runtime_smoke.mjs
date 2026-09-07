import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureDelegationTaskWorkspace } from '../src/main/modules/collaboration/infrastructure/delegationWorkspaceFiles.js';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-group-workspace-runtime-'));

try {
  const firstTaskRoot = ensureDelegationTaskWorkspace(runtimeRoot, 'alice', {
    id: 'delegation-one',
    groupId: 'shared-group',
  });
  const secondTaskRoot = ensureDelegationTaskWorkspace(runtimeRoot, 'alice', {
    id: 'delegation-two',
    metadata: { groupId: 'shared-group' },
  });
  const otherUserRoot = ensureDelegationTaskWorkspace(runtimeRoot, 'bob', {
    id: 'delegation-one',
    groupId: 'shared-group',
  });
  const directTaskRoot = ensureDelegationTaskWorkspace(runtimeRoot, 'alice', {
    id: 'direct-delegation',
  });

  assert.equal(firstTaskRoot, secondTaskRoot, 'all delegations in one group must use one local mirror root for the current user');
  assert.notEqual(firstTaskRoot, otherUserRoot, 'each account keeps its own synchronized device mirror');
  assert.notEqual(firstTaskRoot, directTaskRoot, 'direct delegations must retain a private workspace');
  assert.match(firstTaskRoot.replaceAll('\\', '/'), /task-group-workspaces\/alice\/shared-group$/);
  assert.match(fs.readFileSync(path.join(firstTaskRoot, 'AGENTS.md'), 'utf8'), /visible to all active members/);
  assert.match(fs.readFileSync(path.join(directTaskRoot, 'AGENTS.md'), 'utf8'), /Private uBuddy task workspace/);

  console.log('collaboration group workspace runtime smoke passed');
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
