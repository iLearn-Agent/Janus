import assert from 'node:assert/strict';
import fs from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderPluginSettings } from '../src/renderer/app/views/pluginsView.js';

const rendererSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererSource, /data-plugin-section-toggle/);
assert.match(rendererSource, /data-plugin-page/);
assert.match(rendererSource, /pluginPageIndexes = \{ managed: 0, attached: 0, codex: 0 \}/);

const managedNames = ['Zulu Managed', 'alpha Managed', ...Array.from({ length: 19 }, (_, index) => `Managed ${index + 1}`)];
const attachedNames = ['Zulu Attached', 'alpha Attached', ...Array.from({ length: 19 }, (_, index) => `Attached ${index + 1}`)];
const codexNames = ['Zulu Codex', 'alpha Codex', ...Array.from({ length: 19 }, (_, index) => `Codex ${index + 1}`)];

const managedPlugins = managedNames.map((name, index) => ({
  id: `managed_${index + 1}`,
  name,
  icon: 'plugin',
  category: 'test',
  categoryLabel: 'Test',
  description: `${name} description`,
  tags: [],
  capabilities: [],
  providesAgentIds: [],
  permissions: [],
  recommendedOrder: managedNames.length - index,
  status: { installed: index % 2 === 0, available: true, ready: true },
}));

const attachedSkills = attachedNames.map((name, index) => ({
  id: `attached_${index + 1}`,
  packageId: `package_${index + 1}`,
  skillKey: `attached-key-${index + 1}`,
  name,
  description: `${name} description`,
}));

const codexPlugins = codexNames.map((displayName, index) => ({
  pluginId: `codex-${index + 1}@test-market`,
  name: `codex-${index + 1}`,
  displayName,
  description: `${displayName} description`,
  marketplaceName: 'test-market',
  version: '1.0.0',
  installed: index % 2 === 0,
  enabled: index % 2 === 0,
  authPolicy: 'ON_USE',
}));

function applyCatalogState({ sectionState = null, pageIndexes = { managed: 0, attached: 0, codex: 0 }, query = '' } = {}) {
  Object.assign(state, {
    pluginSearchQuery: query,
    pluginFilter: 'all',
    pluginCategory: 'all',
    pluginSort: 'name',
    pluginSectionsOpen: sectionState || { managed: null, attached: null, codex: null },
    pluginPageIndexes: pageIndexes,
    pluginCatalog: managedPlugins,
    pptxPluginStatus: { installed: false, available: true },
    attachedSkillCatalog: {
      packages: attachedSkills.map((skill) => ({ id: skill.packageId })),
      skills: attachedSkills,
      assignments: [],
      targets: {},
    },
    codexPlugins: {
      capability: { supported: true, version: '0.145.0', source: 'bundled', minimumVersion: '0.144.3' },
      installed: codexPlugins.filter((plugin) => plugin.installed),
      available: codexPlugins.filter((plugin) => !plugin.installed),
      marketplaces: [{ name: 'test-market', root: '/test-market' }],
      legacyMcpConflicts: [],
    },
  });
}

function sectionToggle(markup, key) {
  return markup.match(new RegExp(`<button class="plugins-section-toggle"[^>]*data-plugin-section-toggle="${key}"[^>]*>`))?.[0] || '';
}

applyCatalogState();
const collapsedMarkup = renderPluginSettings();
assert.match(sectionToggle(collapsedMarkup, 'managed'), /aria-expanded="false"/);
assert.match(sectionToggle(collapsedMarkup, 'attached'), /aria-expanded="false"/);
assert.match(sectionToggle(collapsedMarkup, 'codex'), /aria-expanded="false"/);
assert.equal((collapsedMarkup.match(/<article class="plugin-card /g) || []).length, 0);
assert.equal((collapsedMarkup.match(/<article class="attached-skill-row"/g) || []).length, 0);
assert.equal((collapsedMarkup.match(/<article class="codex-plugin-row /g) || []).length, 0);

applyCatalogState({ sectionState: { managed: true, attached: true, codex: true } });
const firstPageMarkup = renderPluginSettings();
assert.equal((firstPageMarkup.match(/<article class="plugin-card /g) || []).length, 20);
assert.equal((firstPageMarkup.match(/<article class="attached-skill-row"/g) || []).length, 20);
assert.equal((firstPageMarkup.match(/<article class="codex-plugin-row /g) || []).length, 20);
assert.equal((firstPageMarkup.match(/data-plugin-page=/g) || []).length, 6);
assert.equal((firstPageMarkup.match(/data-page-direction="next"/g) || []).length, 3);
assert.ok(firstPageMarkup.indexOf('alpha Managed') < firstPageMarkup.indexOf('Managed 1'));
assert.ok(firstPageMarkup.indexOf('alpha Attached') < firstPageMarkup.indexOf('Attached 1'));
assert.ok(firstPageMarkup.indexOf('alpha Codex') < firstPageMarkup.indexOf('Codex 1'));

applyCatalogState({ sectionState: { managed: true, attached: true, codex: true }, pageIndexes: { managed: 1, attached: 1, codex: 1 } });
const secondPageMarkup = renderPluginSettings();
assert.equal((secondPageMarkup.match(/<article class="plugin-card /g) || []).length, 1);
assert.equal((secondPageMarkup.match(/<article class="attached-skill-row"/g) || []).length, 1);
assert.equal((secondPageMarkup.match(/<article class="codex-plugin-row /g) || []).length, 1);
assert.match(secondPageMarkup, /data-page-direction="previous"/);
assert.doesNotMatch(secondPageMarkup, /alpha Managed/);

applyCatalogState({ sectionState: { managed: false, attached: false, codex: false }, query: 'Codex 19' });
const searchMarkup = renderPluginSettings();
assert.match(sectionToggle(searchMarkup, 'managed'), /aria-expanded="false"/);
assert.match(sectionToggle(searchMarkup, 'attached'), /aria-expanded="false"/);
assert.match(sectionToggle(searchMarkup, 'codex'), /aria-expanded="true"/);
assert.match(sectionToggle(searchMarkup, 'codex'), /disabled/);
assert.match(searchMarkup, /Codex 19/);
assert.doesNotMatch(searchMarkup, /Zulu Codex/);

Object.assign(state, {
  pluginSearchQuery: '',
  pluginSectionsOpen: { managed: null, attached: null, codex: null },
  pluginCatalog: managedPlugins.slice(0, 3),
  attachedSkillCatalog: { ...state.attachedSkillCatalog, skills: attachedSkills.slice(0, 3) },
  codexPlugins: { ...state.codexPlugins, installed: codexPlugins.slice(0, 2), available: codexPlugins.slice(2, 3) },
});
const smallCatalogMarkup = renderPluginSettings();
assert.match(sectionToggle(smallCatalogMarkup, 'managed'), /aria-expanded="true"/);
assert.match(sectionToggle(smallCatalogMarkup, 'attached'), /aria-expanded="false"/);
assert.match(sectionToggle(smallCatalogMarkup, 'codex'), /aria-expanded="true"/);

assert.ok(smallCatalogMarkup.indexOf('Janus 自研技能') < smallCatalogMarkup.indexOf('Codex 插件'));
assert.ok(smallCatalogMarkup.indexOf('Codex 插件') < smallCatalogMarkup.indexOf('独立 Skills'));

console.log('plugin directory renderer smoke passed');
