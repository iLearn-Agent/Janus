import assert from 'node:assert/strict';
import fs from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderPluginSettings } from '../src/renderer/app/views/pluginsView.js';

const view = fs.readFileSync(new URL('../src/renderer/app/views/pluginsView.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8');
const messageSendController = fs.readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../src/renderer/styles/plugins.css', import.meta.url), 'utf8');

assert.match(view, /id="attached-skill-source"/);
assert.match(view, /data-attached-skill-pick-source/);
assert.match(view, /data-attached-skill-import/);
assert.match(view, /data-attached-skill-assign/);
assert.match(view, /attached-skill-batch-skills/);
assert.match(view, /attached-skill-batch-targets/);
assert.match(view, /data-attached-skill-batch/);
assert.match(view, /data-attached-skill-unassign/);
assert.match(view, /data-attached-skill-disable-package/);
assert.match(view, /'department'/);
assert.match(view, /'agent_family'/);
assert.match(view, /'agent_instance'/);
assert.match(app, /setAttachedSkillAssignment\(\{ skillId, target, enabled \}\)/);
assert.match(app, /removeAttachedSkillAssignment\(\{/);
assert.match(preload, /skills:attached-import/);
assert.match(preload, /skills:attached-assign/);
assert.match(preload, /skills:attached-assign-batch/);
assert.match(preload, /skills:attached-effective/);
assert.match(preload, /onAttachedSkillsChanged/);
assert.match(preload, /skills:attached-changed/);
assert.match(app, /onAttachedSkillsChanged/);
assert.match(app, /state\.attachedSkillCatalog = payload\.catalog/);
assert.match(messageSendController, /result\.attachedSkillControl/);
assert.match(messageSendController, /state\.attachedSkillCatalog = attachedSkillCatalog/);
assert.match(view, /localizedPluginDescription/);
assert.match(view, /descriptionZhCn/);
assert.match(view, /Installed · unassigned/);
assert.match(view, /已安装 · 未分配/);
assert.match(styles, /\.attached-skill-assignment-controls/);
assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.attached-skill-assignment-controls/);

Object.assign(state, {
  attachedSkillCatalog: {
    packages: [{ id: 'pkg-localized' }],
    skills: [{
      id: 'skill-localized', packageId: 'pkg-localized', name: 'localized-skill',
      displayNameEn: 'Localized Skill', displayNameZhCn: '本地化技能',
      description: 'Canonical description', descriptionEn: 'English purpose', descriptionZhCn: '中文用途说明',
    }],
    assignments: [], targets: { departments: [], agentFamilies: [], agentInstances: [] },
  },
  codexPlugins: { capability: { supported: false }, installed: [], available: [], marketplaces: [], legacyMcpConflicts: [] },
  pluginCatalog: [], pptxPluginStatus: { installed: false, available: true }, pluginSearchQuery: '',
  pluginSectionsOpen: { managed: true, attached: true, codex: true },
});
state.languageMode = 'en';
const englishMarkup = renderPluginSettings();
assert.match(englishMarkup, /Localized Skill/);
assert.match(englishMarkup, /English purpose/);
assert.match(englishMarkup, /Installed · unassigned/);
state.languageMode = 'zh-CN';
const chineseMarkup = renderPluginSettings();
assert.match(chineseMarkup, /本地化技能/);
assert.match(chineseMarkup, /中文用途说明/);
assert.match(chineseMarkup, /已安装 · 未分配/);

console.log(JSON.stringify({
  ok: true,
  checks: ['import_source', 'directory_picker', 'scope_targets', 'enable_disable', 'remove_assignment', 'disable_package',
    'ipc_bridge', 'realtime_catalog_sync', 'localized_metadata', 'installed_assignment_status', 'responsive_layout'],
}));
