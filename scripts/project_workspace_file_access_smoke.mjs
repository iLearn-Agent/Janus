import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeFile, renderUploadedFile } from '../src/main/files.js';
import { createFileRuntimeApi } from '../src/main/modules/artifacts/application/createFileRuntimeApi.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-project-file-access-'));
const runtimeRoot = path.join(base, 'runtime');
const projectRoot = path.join(base, 'project');
const otherRoot = path.join(base, 'other-project');
fs.mkdirSync(runtimeRoot);
fs.mkdirSync(projectRoot);
fs.mkdirSync(otherRoot);

const runtimeFile = path.join(runtimeRoot, 'upload.txt');
const projectFile = path.join(projectRoot, 'generated.md');
const otherFile = path.join(otherRoot, 'outside.md');
fs.writeFileSync(runtimeFile, 'runtime upload');
fs.writeFileSync(projectFile, '# generated in selected project');
fs.writeFileSync(otherFile, '# outside selected project');

const user = { id: 'workspace-user', role: 'member' };
const sessions = new Map([
  ['session-project', { id: 'session-project', userId: user.id, workspaceId: 'workspace_personal', projectId: 'project-a', workspaceRoot: projectRoot }],
]);
const projects = new Map([
  ['project-a', { id: 'project-a', userId: user.id, workspaceId: 'workspace_personal', workspaceRoot: projectRoot }],
  ['project-b', { id: 'project-b', userId: user.id, workspaceId: 'workspace_personal', workspaceRoot: otherRoot }],
  ['foreign-project', { id: 'foreign-project', userId: 'another-user', workspaceId: 'workspace_personal', workspaceRoot: otherRoot }],
]);
const messages = new Map([
  ['message-output', {
    id: 'message-output',
    sessionId: 'session-project',
    metadata: { outputArtifacts: [{ name: 'generated.md', path: projectFile }] },
  }],
  ['message-ppt-artifact', {
    id: 'message-ppt-artifact',
    sessionId: 'session-project',
    content: `__JANUS_ARTIFACT__${JSON.stringify({ kind: 'ppt', data: { deck_file: { path: projectFile } } })}`,
    metadata: { artifact: { kind: 'ppt' } },
  }],
  ['message-relative-output', {
    id: 'message-relative-output',
    sessionId: 'session-project',
    metadata: { outputArtifacts: [{ name: 'generated.md', workspace_relative_path: 'generated.md' }] },
  }],
]);
const auth = {
  requireUser: () => user,
  canAccessSession: (actor, session) => Boolean(actor && session && session.userId === actor.id),
};
const store = {
  getSession: (id) => sessions.get(id) || null,
  getMessage: (id) => messages.get(id) || null,
  getProject: (id) => projects.get(id) || null,
  activeAccountWorkspace: () => ({ id: 'workspace_personal' }),
};
const api = createFileRuntimeApi({
  auth,
  store,
  runtimeRoot,
  upload: () => null,
  uploadFromPath: () => null,
  render: renderUploadedFile,
  renderAsync: async (...args) => renderUploadedFile(...args),
  describe: describeFile,
});

try {
  const internal = api.describeFile({ path: runtimeFile, sessionId: 'session-project', projectId: 'project-a' });
  assert.equal(internal.path, fs.realpathSync(runtimeFile));

  const projectPreview = api.renderUploadedFile({ path: projectFile, sessionId: 'session-project', projectId: 'project-a' });
  assert.equal(projectPreview.kind, 'markdown');
  assert.equal(projectPreview.relative_path, 'generated.md');
  assert.match(projectPreview.text, /selected project/);
  assert.match((await api.renderUploadedFileAsync({ path: projectFile, sessionId: 'session-project', projectId: 'project-a' })).text, /selected project/);

  const historicalPreview = api.renderUploadedFile({ path: projectFile, messageId: 'message-output' });
  assert.equal(historicalPreview.kind, 'markdown');
  assert.match(historicalPreview.text, /selected project/);
  assert.equal(api.describeFile({ path: projectFile, messageId: 'message-output' }).path, fs.realpathSync(projectFile));
  assert.equal(api.describeFile({ path: projectFile, messageId: 'message-ppt-artifact' }).path, fs.realpathSync(projectFile));
  assert.equal(api.describeFile({ relative_path: 'generated.md', messageId: 'message-relative-output' }).path, fs.realpathSync(projectFile));
  assert.match(api.renderUploadedFile({ relative_path: 'generated.md', messageId: 'message-relative-output' }).text, /selected project/);
  assert.throws(
    () => api.describeFile({ path: otherFile, messageId: 'message-output' }),
    /不属于指定的历史消息/,
  );

  assert.throws(() => api.describeFile({ path: projectFile }), /文件路径不在工作区内/);
  assert.throws(
    () => api.describeFile({ path: otherFile, sessionId: 'session-project', projectId: 'project-a' }),
    /文件路径不在工作区内/,
  );
  assert.throws(
    () => api.describeFile({ path: otherFile, sessionId: 'session-project', projectId: 'project-b' }),
    /文件所属项目与当前会话不一致/,
  );
  assert.throws(
    () => api.describeFile({ path: otherFile, projectId: 'foreign-project' }),
    /无权访问该项目的文件/,
  );

  if (process.platform !== 'win32') {
    const escapedLink = path.join(projectRoot, 'escaped-link.md');
    fs.symlinkSync(otherFile, escapedLink);
    assert.throws(
      () => api.describeFile({ path: escapedLink, sessionId: 'session-project', projectId: 'project-a' }),
      /文件路径不在工作区内/,
    );
  }

  process.stdout.write('Project workspace file access smoke passed.\n');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
