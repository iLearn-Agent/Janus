import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyPptIntent } from '../src/main/pptIntent.js';
import { selectBestUBuddyCandidate } from '../src/main/modules/orchestration/application/uBuddyTaskGraphPlanner.js';

const request = '请根据本周工作主题生成内容并制作一份可编辑 PPT。';
assert.equal(classifyPptIntent(request).creation, true);

const candidates = [
  { agentId: 'general_agent', agentInstanceId: 'general-1', departmentId: 'general', effectiveSkill: '整理内容和报告', performanceLevel: 'P5' },
  { agentId: 'ppt', agentInstanceId: 'ppt-1', departmentId: 'ppt_department', effectiveSkill: '根据主题生成 PPT 内容并制作 PPTX', performanceLevel: 'P2' },
];
const pptCandidates = candidates.filter((candidate) => candidate.departmentId === 'ppt_department');
assert.equal(selectBestUBuddyCandidate(pptCandidates, { departmentId: 'ppt_department', prompt: request }).agentId, 'ppt');

for (const relativePath of [
  '../src/main/modules/collaboration/application/createDelegationRuntimeApi.js',
  '../src/main/modules/collaboration/application/createCollaborationGroupRuntimeApi.js',
]) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  assert.match(source, /pptCreationRequested/);
  assert.match(source, /candidate\.departmentId === 'ppt_department'/);
  assert.match(source, /if \(!pptCreationRequested\) \{\s*ensureDelegationEditableDraftFile/s);
  assert.match(source, /(?:不会用|没有用)(?:对话记录或 )?Markdown 草稿冒充/);
}

console.log('uBuddy PPT delegation contract check passed');
