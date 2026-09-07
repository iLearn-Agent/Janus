import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { renderJanusApp } from '../src/renderer/app/views/janusAppView.js';
import { renderSidebar } from '../src/renderer/app/views/navigationView.js';

Object.assign(state, {
  currentUser: { id: 'janus-app-smoke', displayName: 'Janus App Smoke' },
  currentTab: 'janus-app',
  accountMenuOpen: false,
});

const sidebar = renderSidebar();
const talentPosition = sidebar.indexOf('data-tab="employees"');
const pluginsPosition = sidebar.indexOf('data-tab="plugins"');
const appPosition = sidebar.indexOf('data-tab="janus-app"');
assert.ok(talentPosition >= 0, 'Talent navigation must remain available');
assert.ok(pluginsPosition > talentPosition, 'Plugins & Skills must appear below Talent');
assert.ok(appPosition > pluginsPosition, 'Janus App must appear below Plugins & Skills');
assert.match(sidebar.slice(pluginsPosition, sidebar.indexOf('</button>', pluginsPosition)), /插件与技能/);
assert.match(sidebar, /class="tab-btn active"[^>]*data-tab="janus-app"[^>]*aria-current="page"/);
const appNavigation = sidebar.slice(appPosition, sidebar.indexOf('</button>', appPosition));
assert.match(appNavigation, /<svg/);
assert.doesNotMatch(appNavigation, /assets\/icons\/icon\.png/);

state.currentTab = 'plugins';
const pluginSidebar = renderSidebar();
assert.match(pluginSidebar, /class="tab-btn active"[^>]*data-tab="plugins"[^>]*aria-current="page"/);
state.currentTab = 'janus-app';

const page = renderJanusApp();
assert.match(page, /data-page-kind="janus-app"/);
assert.match(page, /id="janus-app-page-title">Janus App</);
assert.equal((page.match(/assets\/icons\/icon\.png/g) || []).length, 2);
assert.match(page, /class="janus-app-dynamic-island"/);
assert.match(page, /class="janus-app-home-indicator"/);
assert.doesNotMatch(page, /janus-app-device-(?:action|volume|power|time)/);
assert.match(page, /iOS/);
assert.match(page, /Android/);

console.log('Janus App navigation smoke passed.');
