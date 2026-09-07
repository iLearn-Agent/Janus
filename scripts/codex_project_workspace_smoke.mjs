import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { codexExecCommand, codexSessionCommand } from '../src/main/codex.js';
import { createRuntime, withWorkspaceBoundary } from '../src/main/runtime.js';
import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-project-workspace-'));
const projectA = path.join(root, 'project-a');
const projectB = path.join(root, 'project-b');
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });
fs.writeFileSync(path.join(projectA, 'AGENTS.md'), '# Project rules\n\n- Generated source files belong under src/.\n');
const runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });

try {
  const sessionCommand = codexSessionCommand({
    codexBin: 'codex',
    root,
    cwd: projectA,
    outputPath: path.join(root, 'last.txt'),
  });
  const execCommand = codexExecCommand({
    codexBin: 'codex',
    root,
    cwd: projectA,
    outputPath: path.join(root, 'exec-last.txt'),
  });
  const resumedSessionCommand = codexSessionCommand({
    codexBin: 'codex',
    root,
    cwd: projectA,
    outputPath: path.join(root, 'resumed-last.txt'),
    threadId: '019c0ba4-5039-7e92-a911-85570cb228b8',
    sandbox: 'workspace-write',
  });
  assert.ok(sessionCommand.includes('--cd'));
  assert.equal(sessionCommand[sessionCommand.indexOf('--cd') + 1], projectA);
  assert.ok(execCommand.includes('--cd'));
  assert.equal(execCommand[execCommand.indexOf('--cd') + 1], projectA);
  assert.ok(resumedSessionCommand.includes('--cd'));
  assert.equal(resumedSessionCommand[resumedSessionCommand.indexOf('--cd') + 1], projectA);
  assert.ok(resumedSessionCommand.includes('--sandbox'));
  assert.equal(resumedSessionCommand[resumedSessionCommand.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(resumedSessionCommand.indexOf('--cd') < resumedSessionCommand.indexOf('exec'));
  assert.ok(resumedSessionCommand.indexOf('--sandbox') < resumedSessionCommand.indexOf('exec'));
  assert.ok(!sessionCommand.includes('--ignore-rules'));
  assert.ok(!execCommand.includes('--ignore-rules'));

  const bounded = withWorkspaceBoundary('Complete the task.', projectA);
  assert.match(bounded, /applicable AGENTS\.md/);
  assert.match(bounded, /project's existing structure and conventions/);
  assert.match(bounded, /workspace-relative paths/);
  assert.match(bounded, /do not prefix paths with the project root, a drive letter, \$HOME/);
  assert.doesNotMatch(bounded, /preferably under (?:its )?outputs/);

  let session = runtime.store.createSession({
    title: 'Workspace thread reset',
    projectId: 'project-a',
    workspaceRoot: projectA,
  });
  runtime.store.updateSessionThread(session.id, 'thread-project-a');
  session = runtime.store.updateSession(session.id, { projectId: 'project-b', workspaceRoot: projectB });
  assert.equal(session.codexThreadId, '', 'changing projects must start a new Codex thread with the new cwd and AGENTS hierarchy');

  const previous = {
    projects: state.projects,
    workspaceMenuOpen: state.workspaceMenuOpen,
    workspaceCreateMenuOpen: state.workspaceCreateMenuOpen,
    activeProjectId: state.activeProjectId,
    workspaceRoot: state.workspaceRoot,
    workspaceDetached: state.workspaceDetached,
    workspaceProjectQuery: state.workspaceProjectQuery,
  };
  try {
    state.projects = [];
    state.workspaceMenuOpen = true;
    state.workspaceCreateMenuOpen = true;
    state.activeProjectId = '';
    state.workspaceRoot = '';
    state.workspaceDetached = false;
    const emptyMarkup = renderChat();
    assert.ok(!emptyMarkup.includes('>无项目<'));
    assert.ok(emptyMarkup.includes('>新建项目<'));
    assert.ok(emptyMarkup.includes('>新建文件夹<'));
    assert.ok(emptyMarkup.includes('>使用现有文件夹<'));

    state.projects = [{ id: 'project-a', title: 'Project A', workspaceRoot: projectA, status: 'active' }];
    const populatedMarkup = renderChat();
    assert.ok(populatedMarkup.includes('>无项目<'));
    assert.ok(populatedMarkup.includes('placeholder="搜索项目"'));
    assert.ok(populatedMarkup.includes('workspace-project-scroll'));
  } finally {
    Object.assign(state, previous);
  }
  console.log('Codex project workspace smoke passed.');
} finally {
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}
