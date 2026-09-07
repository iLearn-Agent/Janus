export const PERSONAL_OVERLAY_COMPILER_VERSION = 'overlay_concat_v1';
const PERSONAL_OVERLAY_START = '<!-- JANUS PERSONAL OVERLAY START -->';
const PERSONAL_OVERLAY_END = '<!-- JANUS PERSONAL OVERLAY END -->';

export function compileEffectiveSkill(baseSkill = '', overlayText = '') {
  const base = String(baseSkill || '');
  const overlay = String(overlayText || '').trim();
  if (!overlay) return base;
  return `${base.trimEnd()}\n\n${PERSONAL_OVERLAY_START}\n${overlay}\n${PERSONAL_OVERLAY_END}\n`;
}
