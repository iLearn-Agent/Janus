import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { renderEmployeeOverlays } from '../src/renderer/app/views/employeesView.js';

const previous = {
  employeeOverview: state.employeeOverview,
  employeeSelectedInstanceId: state.employeeSelectedInstanceId,
  employeeDetailTab: state.employeeDetailTab,
  employeeMarketDrawer: state.employeeMarketDrawer,
  employeeMemoryDrawer: state.employeeMemoryDrawer,
  employeeGrowthDrawer: state.employeeGrowthDrawer,
  userAgentSettings: state.userAgentSettings,
  evolutionPreference: state.evolutionPreference,
};

try {
  state.employeeOverview = { roster: [{
    id: 'skill-instance', agentFamilyId: 'skill-family', displayName: 'Skill Agent',
    family: { id: 'skill-family', name: 'Skill Agent' }, activePersonalSkillVersionId: 'personal-v2',
  }] };
  state.userAgentSettings = [{ id: 'skill-instance', agentFamilyId: 'skill-family', activePersonalSkillVersionId: 'personal-v2' }];
  state.employeeSelectedInstanceId = 'skill-instance';
  state.employeeDetailTab = 'skill';
  state.employeeMemoryDrawer = null;
  state.employeeGrowthDrawer = null;
  state.evolutionPreference = { enabled: true };
  state.employeeMarketDrawer = {
    source: 'employees', agentInstanceId: 'skill-instance', agentFamilyId: 'skill-family', familyName: 'Skill Agent',
    recruited: true, loading: false, busy: false, error: '', personalError: '', conflictPreview: null,
    effectiveSkill: { marketVersionId: 'market-v2', fullMarketVersionId: 'market-v2', effectiveSkillHash: 'private-hash', effectiveSkill: 'private compiled Skill content' },
    items: [
      { id: 'market-v1', status: 'released', createdAt: '2026-07-01T00:00:00.000Z', sections: [] },
      { id: 'market-v2', status: 'released', parentVersionId: 'market-v1', createdAt: '2026-07-02T00:00:00.000Z', sections: [
        { sectionId: 'verification', title: '交付验证', contentHash: 'v2', content: 'private market section content' },
      ] },
    ],
    personalVersions: { items: [
      { id: 'personal-v1', status: 'archived', stabilityStatus: 'stable', createdAt: '2026-07-03T00:00:00.000Z', overlayText: '先给出简短结论。' },
      { id: 'personal-v2', status: 'active', stabilityStatus: 'stable', createdAt: '2026-07-04T00:00:00.000Z', overlayText: '优先给出可执行的恢复步骤。' },
    ] },
  };

  const markup = renderEmployeeOverlays();
  assert.match(markup, /data-employee-detail-tab="skill"[^>]*>Skill<\/button>/);
  assert.match(markup, /市场版本[\s\S]*同类 Agent 共享的能力基础/);
  assert.match(markup, /我的版本[\s\S]*只属于这个 Agent 实例/);
  assert.match(markup, /v2[\s\S]*新增「交付验证」[\s\S]*当前使用/);
  assert.match(markup, /个人版 2[\s\S]*优先给出可执行的恢复步骤[\s\S]*当前使用/);
  assert.match(markup, /取消个人叠加/);
  assert.doesNotMatch(markup, /Canary|技术信息|编译算法|有效 Hash|private-hash|private compiled Skill content|private market section content/);
  process.stdout.write('Employee Skill selector smoke passed.\n');
} finally {
  Object.assign(state, previous);
}
