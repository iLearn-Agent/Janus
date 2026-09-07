import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderFilePreview } from '../src/main/files.js';
import { renderPreviewBody } from '../src/renderer/app/components/overlays.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-office-preview-'));
const previousConverter = process.env.JANUS_OFFICE_CONVERTER;
const previousFakePdf = process.env.JANUS_FAKE_OFFICE_PDF;

try {
  const pdfPath = path.join(root, 'fixture.pdf');
  const pdfResult = spawnSync('python3', ['-c', String.raw`
import fitz
import sys
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 72), 'Office preview fixture')
doc.save(sys.argv[1])
`, pdfPath], { encoding: 'utf8' });
  assert.equal(pdfResult.status, 0, pdfResult.stderr || pdfResult.stdout);
  const nativePdfPreview = renderFilePreview(root, pdfPath);
  assert.equal(nativePdfPreview.kind, 'pdf');
  assert.equal(nativePdfPreview.page_image_render_mode, 'pages');
  assert.equal(nativePdfPreview.page_image_urls.length, 1);
  const renderedPagePath = fileURLToPath(nativePdfPreview.page_image_urls[0]);
  const dimensions = spawnSync('python3', ['-c', String.raw`
import fitz
import sys
pix = fitz.Pixmap(sys.argv[1])
print(f"{pix.width}x{pix.height}")
`, renderedPagePath], { encoding: 'utf8' });
  assert.equal(dimensions.status, 0, dimensions.stderr || dimensions.stdout);
  assert.ok(Number(dimensions.stdout.split('x')[0]) >= 1100, `preview page should be rendered sharply, received ${dimensions.stdout.trim()}`);
  assert.match(renderPreviewBody(nativePdfPreview), /class="preview-document-main is-pages"/);

  const converterPath = path.join(root, 'fake-libreoffice.mjs');
  fs.writeFileSync(converterPath, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const outDir = args[args.indexOf('--outdir') + 1];
const source = args.at(-1);
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(process.env.JANUS_FAKE_OFFICE_PDF, path.join(outDir, path.basename(source, path.extname(source)) + '.pdf'));
`);
  fs.chmodSync(converterPath, 0o755);
  process.env.JANUS_OFFICE_CONVERTER = converterPath;
  process.env.JANUS_FAKE_OFFICE_PDF = pdfPath;

  const legacySignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  for (const extension of ['doc', 'xls', 'ppt']) {
    const file = path.join(root, `valid.${extension}`);
    fs.writeFileSync(file, Buffer.concat([legacySignature, Buffer.alloc(256, extension)]));
    const preview = renderFilePreview(root, file);
    assert.equal(preview.kind, extension);
    assert.equal(preview.preview_render_mode, 'office');
    assert.ok(preview.office_pdf_url, `${extension} must receive a PDF-backed preview`);
    assert.equal(preview.preview_converter, 'LibreOffice');
    assert.ok(preview.page_image_urls.length, `${extension} must provide page thumbnails`);
    assert.equal(preview.page_image_render_mode, 'pages');
    const body = renderPreviewBody(preview);
    assert.match(body, /class="preview-document-shell"/);
    assert.match(body, /class="preview-document-thumbs"/);
    assert.match(body, /class="preview-document-main is-pages"/);
    assert.match(body, /class="preview-document-pages"/);
    assert.doesNotMatch(body, /class="preview-frame preview-office-pdf"/);
    assert.match(renderPreviewBody({ ...preview, page_image_render_mode: 'thumbnails' }), /class="preview-frame preview-office-pdf"/);
  }

  for (const extension of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']) {
    const file = path.join(root, `disguised.${extension}`);
    fs.writeFileSync(file, `plain text renamed to .${extension}`);
    const preview = renderFilePreview(root, file);
    assert.equal(preview.preview_render_mode, 'fallback');
    assert.match(preview.preview_error_code, /office_(?:format_mismatch|encrypted_or_format_mismatch)/);
    assert.match(preview.text, /结构无效|内容与扩展名不匹配|直接改名/);
    assert.doesNotMatch(preview.text, /Install LibreOffice\/WPS\/Office/);
    assert.match(renderPreviewBody(preview), /无法生成内嵌预览/);
  }

  const filesSource = fs.readFileSync(new URL('../src/main/files.js', import.meta.url), 'utf8');
  const previewStyles = fs.readFileSync(new URL('../src/renderer/styles/attachments-preview.css', import.meta.url), 'utf8');
  assert.match(previewStyles, /\.preview-body\.is-pdf\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(previewStyles, /\.preview-document-shell\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
  assert.match(previewStyles, /\.preview-document-sidebar-toggle svg\s*\{[^}]*width:\s*17px/s);
  assert.match(previewStyles, /\.preview-document-main \.preview-frame,[^}]*height:\s*100%/s);
  for (const progId of ['Word.Application', 'KWPS.Application', 'Excel.Application', 'KET.Application', 'PowerPoint.Application', 'KWPP.Application']) {
    assert.match(filesSource, new RegExp(progId.replace('.', '\\.')));
  }
  assert.match(filesSource, /'-File', scriptPath, '-Source', source, '-Target', target/);

  process.stdout.write('Office preview conversion smoke passed.\n');
} finally {
  if (previousConverter === undefined) delete process.env.JANUS_OFFICE_CONVERTER;
  else process.env.JANUS_OFFICE_CONVERTER = previousConverter;
  if (previousFakePdf === undefined) delete process.env.JANUS_FAKE_OFFICE_PDF;
  else process.env.JANUS_FAKE_OFFICE_PDF = previousFakePdf;
  fs.rmSync(root, { recursive: true, force: true });
}
