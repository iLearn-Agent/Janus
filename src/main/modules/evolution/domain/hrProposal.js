import { extractMarkdownSection } from '../../../gate.js';

export function stripFence(text) {
  let value = String(text || '').trim();
  if (value.startsWith('```')) {
    value = value.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  return value;
}

export function looksNoop(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  const normalized = value.toLowerCase().replace(/[ .。!！]+$/g, '');
  if (['none', 'n/a', 'no', 'no-op', 'no op', 'no patch', 'no replacement', 'not needed', 'no change', 'no changes'].includes(normalized)) return true;
  const firstLine = value.split(/\r?\n/).find((line) => line.trim())?.trim().toLowerCase().replace(/[ .。!！]+$/g, '') || '';
  if (/^no (patch|replacement|full replacement|hr memory patch|hr memory replacement)/.test(firstLine)) return true;
  if (firstLine.startsWith('no ') && /(recommended|needed|required)/.test(firstLine)) return true;
  return firstLine.startsWith('不') && /(建议|需要)/.test(firstLine);
}

export function normalizeHrMemoryReplacement(text) {
  if (looksNoop(text)) return '';
  const value = stripFence(text).trim();
  if (value.startsWith('# HR Memory:')) return value;
  const match = /^# HR Memory:\s*.+$/im.exec(value);
  if (match && /^\s*(?:replace|use|set|write|update|用|替换|写入|设置).{0,120}:\s*/is.test(value.slice(0, match.index))) {
    return value.slice(match.index).trim();
  }
  return value;
}

export function normalizeHrMemoryPatch(text) {
  if (looksNoop(text)) return '';
  return stripFence(text).trim();
}

export function validateHrMemoryReplacement(text) {
  const replacement = normalizeHrMemoryReplacement(text);
  if (!replacement) return [];
  const errors = [];
  if (replacement.includes('```')) errors.push('HR memory replacement must not include markdown code fences.');
  if (!replacement.startsWith('# HR Memory:')) errors.push('HR memory replacement must start with `# HR Memory:`.');
  if (Buffer.byteLength(replacement, 'utf8') > 25 * 1024) errors.push('HR memory replacement exceeds 25KB.');
  if (replacement.split(/\r?\n/).length > 200) errors.push('HR memory replacement exceeds 200 lines.');
  return errors;
}

export function validateHrMemoryPatch(text) {
  const patch = normalizeHrMemoryPatch(text);
  if (!patch) return [];
  const errors = [];
  if (patch.includes('```')) errors.push('HR memory patch must not include markdown code fences.');
  if (patch.includes('# HR Memory:') && !patch.startsWith('# HR Memory:')) errors.push('HR memory patch contains an embedded HR memory document.');
  if (patch.startsWith('# HR Memory:')) errors.push(...validateHrMemoryReplacement(patch));
  if (Buffer.byteLength(patch, 'utf8') > 25 * 1024) errors.push('HR memory patch exceeds 25KB.');
  if (patch.split(/\r?\n/).length > 200) errors.push('HR memory patch exceeds 200 lines.');
  return errors;
}

export function validateHrReviewProposal(proposal) {
  const required = [
    'Department summary', 'Debate transcript', 'Agent roster recommendation', 'Structural change decisions',
    'Proposed new agents', 'Proposed merges or retirements', 'Skill and memory review', 'Eval cases',
    'HR memory replacement', 'HR memory patch', 'Memory migration plan', 'Risks',
  ];
  const errors = required.filter((section) => !extractMarkdownSection(proposal, section)).map((section) => `Missing section: ${section}`);
  const debate = extractMarkdownSection(proposal, 'Debate transcript');
  if (debate && debate.split(/\r?\n/).filter((line) => line.trim()).length < 3) errors.push('Debate transcript is too thin.');
  if (debate && !/\b(agent|hr|chair|leader|manager|writer|researcher|scout|designer|engineer)\b/i.test(debate)) errors.push('Debate transcript does not show agent/HR voices.');
  const roster = extractMarkdownSection(proposal, 'Agent roster recommendation');
  if (roster && !/\b(no change|keep|new agent|split|merge|retire|dismiss|fire|maintain|新增|不新增|保持|拆分|合并|退休|开除)\b/i.test(roster)) errors.push('Agent roster recommendation lacks an explicit staffing decision.');
  errors.push(...validateHrMemoryReplacement(extractMarkdownSection(proposal, 'HR memory replacement')));
  errors.push(...validateHrMemoryPatch(extractMarkdownSection(proposal, 'HR memory patch')));
  return errors;
}
