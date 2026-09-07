import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBufferedSubscriber } from '../src/preload/bufferedSubscriber.js';
import { state } from '../src/renderer/app/state.js';
import { renderNotice } from '../src/renderer/app/components/overlays.js';
import { createUpdatesController } from '../src/renderer/app/features/updates/updatesController.js';

const buffered = createBufferedSubscriber({ limit: 2 });
const firstDelivery = [];
buffered.emit({ id: 'before-listener' });
const removeFirst = buffered.subscribe((payload) => firstDelivery.push(payload.id));
assert.deepEqual(firstDelivery, ['before-listener'], 'a notification click before renderer subscription must be replayed');
buffered.emit({ id: 'live' });
assert.deepEqual(firstDelivery, ['before-listener', 'live'], 'notification clicks must be delivered live after subscription');
removeFirst();
buffered.emit({ id: 'buffered-1' });
buffered.emit({ id: 'buffered-2' });
buffered.emit({ id: 'buffered-3' });
const secondDelivery = [];
buffered.subscribe((payload) => secondDelivery.push(payload.id));
assert.deepEqual(secondDelivery, ['buffered-2', 'buffered-3'], 'the navigation buffer must remain bounded and preserve order');

const previousNotice = state.notice;
state.notice = {
  id: 'actionable-update',
  message: '发现 Janus 更新',
  tone: 'success',
  phase: 'visible',
  placement: '',
  action: { label: '打开更新中心', onClick() {} },
};
const actionableMarkup = renderNotice();
assert.match(actionableMarkup, /app-notice[^\n]*is-actionable/);
assert.match(actionableMarkup, /role="button"/);
assert.match(actionableMarkup, /打开更新中心/);
assert.match(actionableMarkup, /app-notice-action/);
state.notice = { ...state.notice, action: null };
const passiveMarkup = renderNotice();
assert.doesNotMatch(passiveMarkup, /is-actionable/);
assert.match(passiveMarkup, /role="status"/);
state.notice = previousNotice;

const updateState = {
  busy: false,
  currentTab: 'chat',
  currentSettingsSection: '',
  updates: {},
  agentUpdates: {},
  accountMenuOpen: true,
  accountMenuWorkspaceOpen: true,
};
const updateNotices = [];
const updatesController = createUpdatesController({
  state: updateState,
  render() {},
  notify: (...args) => updateNotices.push(args),
  appendStatus() {},
  windowRef: {
    janus: {
      async checkForUpdates() { return { available: true, version: '1.0.1' }; },
      async checkAgentUpdates() { return { available: false }; },
    },
  },
  documentRef: { querySelector: () => ({ scrollIntoView() {} }) },
  requestFrame: (callback) => callback(),
  isCurrentUserAdmin: () => true,
  effectiveJanusVersion: () => '1.0.0',
  compareSemanticVersions: () => 0,
});
await updatesController.checkAllUpdates();
const updateNoticeAction = updateNotices.at(-1)?.[4];
assert.equal(updateNoticeAction?.label, '打开更新中心');
assert.equal(typeof updateNoticeAction?.onClick, 'function');
updateNoticeAction.onClick();
assert.equal(updateState.currentTab, 'settings');
assert.equal(updateState.currentSettingsSection, 'account');
assert.equal(updateState.accountMenuOpen, false);

const preloadSource = readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const updatesSource = readFileSync(new URL('../src/renderer/app/features/updates/updatesController.js', import.meta.url), 'utf8');

for (const channel of ['social:open-task', 'system:open-conversation', 'system:open-agent-session', 'system:open-updates']) {
  assert.match(preloadSource, new RegExp(`createBufferedNavigationSubscription\\('${channel.replaceAll(':', '\\:')}'\\)`));
}
assert.match(mainSource, /!window\.webContents\.getURL\(\) \|\| window\.webContents\.isLoadingMainFrame\(\)/);
assert.ok(
  rendererSource.indexOf('installSystemNotificationNavigationListeners();')
    > rendererSource.indexOf('configureCollaborationView({ agentNameById });'),
  'system notification navigation must be installed only after local bootstrap is rendered',
);
assert.match(rendererSource, /\['Enter', ' '\]\.includes\(event\.key\)/);
assert.match(updatesSource, /label: '打开更新中心',[\s\S]*onClick: handleAccountUpdateClick/);

console.log('system notification navigation smoke passed');
