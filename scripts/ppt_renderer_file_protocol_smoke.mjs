import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { projectRoot } from '../src/main/paths.js';
import { pythonEnvironment, resolvePythonInvocation } from '../src/main/python.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-ppt-file-protocol-'));
const payloadPath = path.join(root, 'payload.json');
const resultPath = path.join(root, 'result.jsonl');
const progressPath = path.join(root, 'progress.jsonl');
const rendererScript = path.join(projectRoot, 'src', 'main', 'ppt_service', 'render_ppt.py');

try {
  const assistantAnswer = [
    '```janus-slide-plan',
    '| layout_id | title | message | proof_object | visual | speaker_note | time |',
    '|---|---|---|---|---|---|---|',
    '| basic_content | 文件协议启动 | 标准流关闭后仍可完成渲染 | 启动检查 | 可编辑文本和图形 | 验证生产启动方式 | 30s |',
    '| summary_takeaways | 验证完成 | PPTX、结果和进度文件均完整 | 三项结果 | 可编辑结论卡片 | 确认文件协议可交付 | 30s |',
    '```',
  ].join('\n');
  const payload = {
    root,
    user_id: 'ppt-file-protocol-smoke',
    agent_id: 'ppt',
    session_id: `ppt-file-protocol-${Date.now()}`,
    user_message: '生成一份文件协议回归测试 PPT',
    assistant_answer: assistantAnswer,
    selected_style: 'general',
    selected_template: 'none',
    source_image_paths: [],
    pre_generated_image_paths: {},
    enable_imagegen: false,
    minimum_content_images: 0,
    include_notes_artifact: false,
  };
  await Promise.all([
    fsp.writeFile(payloadPath, JSON.stringify(payload), 'utf8'),
    fsp.writeFile(resultPath, '', 'utf8'),
    fsp.writeFile(progressPath, '', 'utf8'),
  ]);

  const invocation = resolvePythonInvocation([
    rendererScript,
    '--payload-file', payloadPath,
    '--result-file', resultPath,
    '--progress-file', progressPath,
  ], {
    required: true,
    root,
    requiredModules: ['pptx', 'PIL', 'fitz', 'lxml'],
  });
  const exitCode = await runIgnoredStdio(invocation.command, invocation.args, {
    cwd: projectRoot,
    env: {
      ...pythonEnvironment({
        JANUS_PPT_ENABLE_IMAGEGEN: '0',
        JANUS_PPT_ENABLE_RESEARCH: '0',
        JANUS_PPT_COM_EXPORT: '0',
        JANUS_PPT_PREVIEW_COM: '0',
      }, { root, packaged: invocation.packaged }),
      PYTHONIOENCODING: 'utf-8',
    },
  });
  const progressText = await fsp.readFile(progressPath, 'utf8');
  assert.equal(exitCode, 0, progressText || `Renderer exited with ${exitCode}`);

  const resultLine = (await fsp.readFile(resultPath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const result = JSON.parse(resultLine || '{}');
  assert.equal(result.slide_count, 2);
  assert.ok(result.deck && fs.existsSync(result.deck), 'Renderer must return an existing PPTX path.');
  assert.ok(completeZipPackage(result.deck), 'Renderer must create a complete PPTX ZIP package.');

  const progress = progressText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(progress.some((event) => event.type === 'progress'), 'Renderer must report progress through the file protocol.');
  process.stdout.write(`ppt renderer file protocol smoke passed (${progress.length} progress events)\n`);
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}

function runIgnoredStdio(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('PPT renderer file protocol smoke timed out.'));
    }, 180_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function completeZipPackage(file) {
  const size = fs.statSync(file).size;
  if (size < 1_024) return false;
  const descriptor = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(descriptor, head, 0, head.length, 0);
    if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(descriptor, tail, 0, tailLength, size - tailLength);
    return tail.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } finally {
    fs.closeSync(descriptor);
  }
}
