#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const appDir = path.resolve(argumentValue('--app-dir'));
const runtimeRoot = path.join(appDir, 'resources', 'python');
const pythonExe = path.join(runtimeRoot, 'python.exe');
const required = [
  pythonExe,
  path.join(runtimeRoot, 'python312.dll'),
  path.join(runtimeRoot, 'python312.zip'),
  path.join(runtimeRoot, 'python312._pth'),
  path.join(runtimeRoot, 'Lib', 'site-packages', 'pptx', '__init__.py'),
  path.join(runtimeRoot, 'Lib', 'site-packages', 'PIL', '__init__.py'),
  path.join(runtimeRoot, 'Lib', 'site-packages', 'PIL', '_imaging.cp312-win_amd64.pyd'),
  path.join(runtimeRoot, 'Lib', 'site-packages', 'fitz', '__init__.py'),
  path.join(runtimeRoot, 'Lib', 'site-packages', 'pymupdf', '_mupdf.pyd'),
  path.join(runtimeRoot, 'Lib', 'site-packages', 'lxml', 'etree.cp312-win_amd64.pyd'),
  path.join(runtimeRoot, 'janus-runtime.json'),
];
const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) throw new Error(`Packaged Windows Python runtime is incomplete:\n${missing.join('\n')}`);

const executableHead = Buffer.alloc(2);
const descriptor = fs.openSync(pythonExe, 'r');
try { fs.readSync(descriptor, executableHead, 0, 2, 0); } finally { fs.closeSync(descriptor); }
if (executableHead.toString('ascii') !== 'MZ') throw new Error('Packaged python.exe is not a Windows PE executable.');

const manifest = JSON.parse(await fsp.readFile(path.join(runtimeRoot, 'janus-runtime.json'), 'utf8'));
if (manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.pythonVersion !== '3.12.10') {
  throw new Error(`Unexpected Windows Python runtime manifest: ${JSON.stringify(manifest)}`);
}
for (const requiredPackage of ['python-pptx==1.0.2', 'Pillow==11.3.0', 'PyMuPDF==1.26.3', 'lxml==6.1.1']) {
  if (!manifest.packages?.includes(requiredPackage)) throw new Error(`Windows Python runtime manifest is missing ${requiredPackage}.`);
}
const embeddedPath = await fsp.readFile(path.join(runtimeRoot, 'python312._pth'), 'utf8');
if (!embeddedPath.includes('Lib\\site-packages') || !embeddedPath.includes('import site')) {
  throw new Error('Embedded Python path configuration does not enable the bundled site-packages directory.');
}
const rendererScriptOverride = argumentValue('--renderer-script');
const rendererScript = rendererScriptOverride
  ? path.resolve(rendererScriptOverride)
  : packagedRendererScript(appDir);
if (!fs.existsSync(rendererScript)) throw new Error(`PPT renderer script is missing: ${rendererScript}`);
const rendererSource = await fsp.readFile(rendererScript, 'utf8');
for (const protocolFlag of ['--payload-file', '--result-file', '--progress-file']) {
  if (!rendererSource.includes(protocolFlag)) {
    throw new Error(`Packaged PPT renderer does not support ${protocolFlag}; rebuild the app with the current file-protocol renderer.`);
  }
}
const execution = resolveExecution(pythonExe);
let executed = false;
let probe = null;
let rendererProbe = null;
if (execution) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-windows-python-check-'));
  try {
    const outputRoot = execution.kind === 'wine' ? winePath(tempRoot) : tempRoot;
    const script = [
      'import json, pathlib, sys',
      'from pptx import Presentation',
      'from PIL import Image',
      'import fitz, lxml.etree',
      'root = pathlib.Path(sys.argv[1])',
      'root.mkdir(parents=True, exist_ok=True)',
      'deck = root / "runtime-smoke.pptx"',
      'prs = Presentation()',
      'slide = prs.slides.add_slide(prs.slide_layouts[0])',
      'slide.shapes.title.text = "Janus Windows PPT Runtime"',
      'prs.save(deck)',
      'Image.new("RGB", (32, 32), (37, 99, 235)).save(root / "runtime-smoke.png")',
      'pdf = fitz.open(); pdf.new_page(); pdf.save(root / "runtime-smoke.pdf"); pdf.close()',
      'print(json.dumps({"python": sys.version.split()[0], "deck": deck.stat().st_size}, ensure_ascii=False))',
    ].join('; ');
    const result = spawnSync(execution.command, [...execution.prefixArgs, '-c', script, outputRoot], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      env: { ...process.env, WINEDEBUG: '-all', PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error || result.status !== 0) {
      throw new Error(String(result.error?.message || result.stderr || result.stdout || `Python runtime probe exited with ${result.status}`).trim());
    }
    const jsonLine = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    probe = JSON.parse(jsonLine || '{}');
    for (const name of ['runtime-smoke.pptx', 'runtime-smoke.png', 'runtime-smoke.pdf']) {
      const file = path.join(tempRoot, name);
      if (!fs.existsSync(file) || fs.statSync(file).size <= 0) throw new Error(`Windows Python runtime probe did not create ${name}.`);
    }
    rendererProbe = runRendererProbe({ execution, rendererScript, tempRoot });
    executed = true;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({
  status: 'verified',
  runtimeRoot,
  pythonVersion: manifest.pythonVersion || '',
  packages: manifest.packages || [],
  executed,
  executionKind: execution?.kind || 'static-only',
  probe,
  rendererProbe,
  rendererScriptSource: rendererScriptOverride ? 'override' : 'packaged',
}, null, 2)}\n`);

function packagedRendererScript(packagedAppDir) {
  const candidates = [
    path.join(packagedAppDir, 'resources', 'app.asar.unpacked', 'src', 'main', 'ppt_service', 'render_ppt.py'),
    path.join(packagedAppDir, 'resources', 'app', 'src', 'main', 'ppt_service', 'render_ppt.py'),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`Packaged PPT renderer is missing. Checked:\n${candidates.join('\n')}`);
  return resolved;
}

function runRendererProbe({ execution, rendererScript: scriptPath, tempRoot }) {
  const rendererRoot = path.join(tempRoot, 'renderer');
  fs.mkdirSync(rendererRoot, { recursive: true });
  const pythonScript = execution.kind === 'wine' ? winePath(scriptPath) : scriptPath;
  const payloadRoot = execution.kind === 'wine' ? winePath(rendererRoot) : rendererRoot;
  const payloadPath = path.join(tempRoot, 'renderer-payload.json');
  const resultPath = path.join(tempRoot, 'renderer-result.jsonl');
  const progressPath = path.join(tempRoot, 'renderer-progress.jsonl');
  const assistantAnswer = [
    '```janus-slide-plan',
    '| layout_id | title | message | proof_object | visual | speaker_note | time |',
    '|---|---|---|---|---|---|---|',
    '| basic_content | Windows 渲染链路 | 验证内置 Python 可以生成可编辑页面 | 一张验证卡片 | 可编辑文本框与色块 | 说明运行时来自安装包 | 30s |',
    '| summary_takeaways | 验证完成 | PPTX 与封面均已生成 | 两项检查结果 | 结论卡片 | 确认交付产物可读取 | 30s |',
    '```',
  ].join('\n');
  const payload = {
    root: payloadRoot,
    user_id: 'windows-runtime-smoke',
    agent_id: 'ppt',
    session_id: `windows-runtime-smoke-${Date.now()}`,
    user_message: '生成一份 Windows PPT 渲染链路测试演示文稿',
    assistant_answer: assistantAnswer,
    selected_style: 'general',
    selected_template: 'none',
    source_image_paths: [],
    include_notes_artifact: false,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
  fs.writeFileSync(resultPath, '', 'utf8');
  fs.writeFileSync(progressPath, '', 'utf8');
  const protocolPath = (value) => execution.kind === 'wine' ? winePath(value) : value;
  const result = spawnSync(execution.command, [
    ...execution.prefixArgs,
    pythonScript,
    '--payload-file', protocolPath(payloadPath),
    '--result-file', protocolPath(resultPath),
    '--progress-file', protocolPath(progressPath),
  ], {
    cwd: path.resolve(path.dirname(scriptPath), '..', '..', '..'),
    stdio: 'ignore',
    timeout: 180_000,
    windowsHide: true,
    env: {
      ...process.env,
      WINEDEBUG: '-all',
      PYTHONUTF8: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONIOENCODING: 'utf-8',
      JANUS_PPT_ENABLE_IMAGEGEN: '0',
      JANUS_PPT_ENABLE_RESEARCH: '0',
      JANUS_PPT_COM_EXPORT: '0',
      JANUS_PPT_PREVIEW_COM: '0',
    },
  });
  if (result.error || result.status !== 0) {
    const progress = fs.readFileSync(progressPath, 'utf8').trim();
    throw new Error(String(result.error?.message || progress || `Packaged PPT renderer probe exited with ${result.status}`).trim());
  }
  const jsonLine = fs.readFileSync(resultPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  const rendered = JSON.parse(jsonLine || '{}');
  if (Number(rendered.slide_count || 0) !== 2) {
    throw new Error(`Packaged PPT renderer returned an unexpected slide count: ${rendered.slide_count}`);
  }
  const deck = findFirstFile(rendererRoot, (file) => file.toLowerCase().endsWith('.pptx'));
  const cover = findFirstFile(rendererRoot, (file) => path.basename(file).toLowerCase() === 'cover.png');
  if (!deck || !completeZipPackage(deck)) throw new Error('Packaged PPT renderer did not create a complete PPTX package.');
  if (!cover || fs.statSync(cover).size <= 0) throw new Error('Packaged PPT renderer did not create a cover preview.');
  return {
    slideCount: rendered.slide_count,
    previewMode: rendered.preview_render_mode || '',
    deckBytes: fs.statSync(deck).size,
    coverBytes: fs.statSync(cover).size,
  };
}

function findFirstFile(root, predicate) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFirstFile(candidate, predicate);
      if (nested) return nested;
    } else if (entry.isFile() && predicate(candidate)) {
      return candidate;
    }
  }
  return '';
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

function resolveExecution(executable) {
  if (process.platform === 'win32') return { kind: 'native', command: executable, prefixArgs: [] };
  const wine = commandPath('wine64') || commandPath('wine');
  return wine ? { kind: 'wine', command: wine, prefixArgs: [executable] } : null;
}

function winePath(value) {
  const winepath = commandPath('winepath');
  if (!winepath) return `Z:${String(value).replaceAll('/', '\\')}`;
  const result = spawnSync(winepath, ['-w', value], { encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, WINEDEBUG: '-all' } });
  return result.status === 0 ? String(result.stdout || '').trim() : `Z:${String(value).replaceAll('/', '\\')}`;
}

function commandPath(command) {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').split(/\r?\n/)[0].trim() : '';
}

function argumentValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}
