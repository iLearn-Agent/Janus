import path from 'node:path';

const INSTALL_ACTIONS = new Set(['安装', '导入', '装上', '添加', 'install', 'import', 'add']);

/**
 * Parse only explicit Skill installation/import requests.  The source is kept
 * deliberately bounded so an Agent cannot turn an arbitrary natural-language
 * sentence into a filesystem or network mutation.
 */
export function parseAttachedSkillControlIntent(value = '') {
  const text = String(value || '').trim();
  if (!text || text.includes('\n')) return null;
  const patterns = [
    /^(?:请|麻烦|帮我|给我|为我|请帮我|能否|可以)?\s*(安装|导入|装上|添加)\s*(?:一个|一下)?\s*(?:skill|skills|技能)\s*(.+?)\s*[。.!！?？]*$/i,
    /^(?:please\s+)?(install|import|add)\s+(?:a\s+)?(?:skill|skills)\s+(.+?)\s*[.!?]*$/i,
    /^(?:请|麻烦|帮我|给我|为我|请帮我|能否|可以)?\s*(?:skill|skills|技能)\s*[:：]\s*(.+?)\s*(安装|导入|装上|添加)\s*[。.!！?？]*$/i,
    /^(?:please\s+)?(?:skill|skills)\s*[:：]\s*(.+?)\s+(install|import|add)\s*[.!?]*$/i,
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    if (!match) continue;
    const actionValue = String(index >= 2 ? match[2] : match[1]).toLowerCase();
    const sourceValue = index >= 2 ? match[1] : match[2];
    if (!INSTALL_ACTIONS.has(actionValue)) continue;
    const source = cleanAttachedSkillSource(sourceValue);
    if (!isAllowedAttachedSkillSource(source)) return null;
    const revisionMatch = source.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s]+)$/);
    return {
      action: 'install',
      source: revisionMatch ? revisionMatch[1] : source,
      sourceRevision: revisionMatch ? revisionMatch[2] : '',
      sourceType: sourceTypeForAttachedSkill(source),
      originalSource: source,
    };
  }
  return null;
}

export function cleanAttachedSkillSource(value = '') {
  return String(value || '').trim()
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, '')
    .replace(/[。！!？?，,；;]+$/g, '')
    .trim();
}

export function isAllowedAttachedSkillSource(source = '') {
  const value = cleanAttachedSkillSource(source);
  if (!value || /[\r\n\0]/.test(value) || value.length > 2000) return false;
  if (path.isAbsolute(value)) return true;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[^\s]+)?$/.test(value)) return true;
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(value);
}

function sourceTypeForAttachedSkill(source = '') {
  return path.isAbsolute(source) ? 'local' : 'github';
}
