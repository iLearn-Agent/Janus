import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFileChangeSnapshotRun } from '../src/main/fileChangeSnapshots.js';
import { createRuntime } from '../src/main/runtime.js';
import { resolvePythonInvocation } from '../src/main/python.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-file-snapshot-smoke-'));
const runtimeRoot = path.join(base, 'runtime');
const workspaceRoot = path.join(base, 'project');
const docxPath = path.join(workspaceRoot, 'specification.docx');
const imagePath = path.join(workspaceRoot, 'diagram.png');
const markdownPath = path.join(workspaceRoot, 'notes.md');
fs.mkdirSync(workspaceRoot, { recursive: true });

function writeDocx(file, title, paragraph, tableValue) {
  const script = [
    'import sys, zipfile, html',
    'target,title,paragraph,cell=sys.argv[1:5]',
    'xml=("<?xml version=\\"1.0\\" encoding=\\"UTF-8\\" standalone=\\"yes\\"?>"',
    ' + "<w:document xmlns:w=\\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\\"><w:body>"',
    ' + "<w:p><w:pPr><w:pStyle w:val=\\"Heading1\\"/></w:pPr><w:r><w:t>"+html.escape(title)+"</w:t></w:r></w:p>"',
    ' + "<w:p><w:r><w:t>"+html.escape(paragraph)+"</w:t></w:r></w:p>"',
    ' + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>"+html.escape(cell)+"</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"',
    ' + "<w:sectPr/></w:body></w:document>")',
    'with zipfile.ZipFile(target,"w",zipfile.ZIP_DEFLATED) as z:',
    ' z.writestr("[Content_Types].xml","<Types xmlns=\\"http://schemas.openxmlformats.org/package/2006/content-types\\"/>")',
    ' z.writestr("word/document.xml",xml)',
  ].join('\n');
  const invocation = resolvePythonInvocation(['-c', script, file, title, paragraph, tableValue]);
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to create DOCX fixture.');
}

function writePngHeader(file, width, height, marker) {
  const buffer = Buffer.alloc(64, marker);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  fs.writeFileSync(file, buffer);
}

try {
  writeDocx(docxPath, '旧标题', '旧段落内容', '旧表格值');
  writePngHeader(imagePath, 640, 360, 0x11);
  const snapshots = createFileChangeSnapshotRun({ root: runtimeRoot, cwd: workspaceRoot, runId: 'strict-comparison' });
  assert.equal(snapshots.coverage.status, 'complete');
  assert.equal(snapshots.coverage.capturedFiles, 2);
  const pending = snapshots.observe('file-change-strict', [
    { path: docxPath, kind: 'update' },
    { path: imagePath, kind: 'update' },
  ]);
  assert.equal(pending[0].comparison.status, 'pending');
  assert.equal(pending[0].comparison.baselineCaptured, true);

  writeDocx(docxPath, '新标题', '新的段落内容', '新表格值');
  writePngHeader(imagePath, 1280, 720, 0x22);
  const completed = snapshots.complete('file-change-strict', [
    { path: docxPath, kind: 'update' },
    { path: imagePath, kind: 'update' },
  ]);
  const documentComparison = completed[0].comparison;
  const imageComparison = completed[1].comparison;
  assert.equal(documentComparison.strict, true);
  assert.equal(documentComparison.status, 'complete');
  assert.notEqual(documentComparison.before.sha256, documentComparison.after.sha256);
  assert.ok(documentComparison.semantic.removed.some((item) => item.text.includes('旧标题')));
  assert.ok(documentComparison.semantic.added.some((item) => item.text.includes('新标题')));
  assert.equal(documentComparison.semantic.beforeMetrics.headings, 1);
  assert.equal(documentComparison.semantic.afterMetrics.tables, 1);
  assert.equal(imageComparison.strict, true);
  assert.equal(imageComparison.semantic.beforeMetrics.width, 640);
  assert.equal(imageComparison.semantic.afterMetrics.width, 1280);
  assert.ok(fs.existsSync(documentComparison.before.snapshot.path));
  assert.ok(fs.existsSync(documentComparison.after.snapshot.path));
  snapshots.close();
  assert.ok(fs.existsSync(documentComparison.before.snapshot.path), 'immutable comparison snapshots must survive turn cleanup');

  const addedTextSnapshots = createFileChangeSnapshotRun({ root: runtimeRoot, cwd: workspaceRoot, runId: 'added-text-metrics' });
  addedTextSnapshots.observe('added-markdown', [{ path: markdownPath, kind: 'add' }]);
  const markdownContent = '# New note\n\nInitial content for the created file.';
  fs.writeFileSync(markdownPath, markdownContent);
  const addedText = addedTextSnapshots.complete('added-markdown', [{ path: markdownPath, kind: 'add' }])[0];
  assert.equal(addedText.comparison.strict, true);
  assert.equal(addedText.comparison.semantic.afterMetrics.characters, markdownContent.length);
  assert.equal(addedText.comparison.semantic.afterMetrics.lines, 2);
  addedTextSnapshots.close();

  const interruptedSnapshots = createFileChangeSnapshotRun({ root: runtimeRoot, cwd: workspaceRoot, runId: 'interrupted-comparison' });
  interruptedSnapshots.observe('interrupted-file', [{ path: docxPath, kind: 'update' }]);
  writeDocx(docxPath, '中断后的标题', '中断后的段落', '中断后的表格');
  const finalized = interruptedSnapshots.finalizePending();
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].changes[0].comparison.strict, true);
  interruptedSnapshots.close();

  let runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
  const session = runtime.ensurePrivateAssistantSession();
  const persisted = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '严格对照已完成。',
    agentId: 'private_assistant',
    departmentId: 'private_assistant',
    metadata: {
      processEvents: [{
        activityId: 'persisted-file-change', activityType: 'file', status: 'completed',
        changes: [{ path: docxPath, kind: 'update', comparison: documentComparison }],
      }],
    },
  });
  runtime.close();
  runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
  const recovered = runtime.store.getMessage(persisted.id);
  const recoveredComparison = recovered.metadata.processEvents[0].changes[0].comparison;
  assert.equal(recoveredComparison.strict, true);
  assert.equal(recoveredComparison.before.sha256, documentComparison.before.sha256);
  assert.ok(fs.existsSync(recoveredComparison.before.snapshot.path));
  runtime.close();
  process.stdout.write('File change strict snapshot smoke passed.\n');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
