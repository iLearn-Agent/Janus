import fs from 'node:fs';
import path from 'node:path';

import { readZipEntries } from './zip.js';

const LEGACY_OFFICE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OFFICE_LABELS = new Map([
  ['.doc', 'Word 97–2003 文档'],
  ['.docx', 'Word 文档'],
  ['.xls', 'Excel 97–2003 工作簿'],
  ['.xlsx', 'Excel 工作簿'],
  ['.ppt', 'PowerPoint 97–2003 演示文稿'],
  ['.pptx', 'PowerPoint 演示文稿'],
]);

export const OFFICE_FILE_EXTENSIONS = new Set(OFFICE_LABELS.keys());

export function officeFileLabel(extension = '') {
  return OFFICE_LABELS.get(normalizeOfficeExtension(extension)) || 'Office 文件';
}

export function inspectOfficeFile(filePath = '', extension = '') {
  const ext = normalizeOfficeExtension(extension || path.extname(filePath));
  if (!OFFICE_FILE_EXTENSIONS.has(ext)) return { valid: true, code: '', extension: ext, label: '文件' };
  const label = officeFileLabel(ext);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { valid: false, code: 'office_file_missing', extension: ext, label, message: `${label}不存在或无法读取。` };
  }
  if (!stat.isFile() || stat.size <= 0) {
    return { valid: false, code: 'office_file_empty', extension: ext, label, message: `${label}为空或不是普通文件。` };
  }
  if (['.doc', '.xls', '.ppt'].includes(ext)) {
    if (fileStartsWith(filePath, LEGACY_OFFICE_SIGNATURE)) return { valid: true, code: '', extension: ext, label };
    return {
      valid: false,
      code: 'office_format_mismatch',
      extension: ext,
      label,
      message: `${label}的内容与扩展名不匹配。它可能是将纯文本、HTML 或其他内容直接改名成了 ${ext}。`,
    };
  }
  if (fileStartsWith(filePath, LEGACY_OFFICE_SIGNATURE)) {
    return {
      valid: false,
      code: 'office_encrypted_or_format_mismatch',
      extension: ext,
      label,
      message: `${label}不是可直接解析的 Office Open XML 文件；它可能已加密，或扩展名与实际格式不匹配。`,
    };
  }
  try {
    const entries = readZipEntries(filePath);
    const contentTypesValid = zipEntryHasContent(entries, '[Content_Types].xml');
    const structureValid = ext === '.docx'
      ? zipEntryHasContent(entries, 'word/document.xml')
      : ext === '.xlsx'
        ? zipEntryHasContent(entries, 'xl/workbook.xml')
        : zipEntryHasContent(entries, 'ppt/presentation.xml')
          && [...entries.keys()].some((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name) && zipEntryHasContent(entries, name));
    if (contentTypesValid && structureValid) return { valid: true, code: '', extension: ext, label };
  } catch {
    // The stable mismatch diagnostic below is safer than exposing parser internals or local paths.
  }
  return {
    valid: false,
    code: 'office_format_mismatch',
    extension: ext,
    label,
    message: `${label}结构无效或内容与扩展名不匹配。请重新生成真实的 ${ext} 文件。`,
  };
}

function normalizeOfficeExtension(extension = '') {
  const clean = String(extension || '').trim().toLowerCase();
  return clean && !clean.startsWith('.') ? `.${clean}` : clean;
}

function fileStartsWith(filePath = '', signature = Buffer.alloc(0)) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(signature.length);
    return fs.readSync(fd, buffer, 0, buffer.length, 0) === signature.length && buffer.equals(signature);
  } catch {
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function zipEntryHasContent(entries = new Map(), name = '') {
  try {
    const read = entries.get(name);
    return typeof read === 'function' && Boolean(read()?.length);
  } catch {
    return false;
  }
}
