import assert from 'node:assert/strict';

import {
  createUBuddyFeatureFlagService,
  normalizeUBuddyFeatureFlagConfig,
  UBUDDY_FEATURE_FLAGS,
  UBUDDY_FEATURE_FLAG_SETTING_KEY,
} from '../src/main/modules/collaboration/infrastructure/ubuddyFeatureFlags.js';
import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';

const settings = new Map();
const store = {
  settingGet(key, fallback = '') { return settings.has(key) ? settings.get(key) : fallback; },
};

const stable = createUBuddyFeatureFlagService({ store, env: {}, isDev: false });
assert.equal(stable.snapshot({ userId: 'user-a' }).newTaskWorkspaceUi, true);
assert.equal(stable.snapshot({ userId: 'user-a' }).newDispatchStrategy, true);
assert.equal(stable.snapshot({ userId: 'user-a' }).newProcessEventStream, true);
assert.equal(UBUDDY_FEATURE_FLAGS.structuredTaskReference, 'structured_task_reference_v1');
assert.equal(UBUDDY_FEATURE_FLAGS.profileHistory, 'ubuddy_profile_history_v1');
assert.equal(UBUDDY_FEATURE_FLAGS.agentWorkDetailProjection, 'agent_work_detail_projection_v1');
assert.equal(UBUDDY_FEATURE_FLAGS.boundedDeliveryReworkV1, 'bounded_delivery_rework_v1');
for (const key of [
  'intakeClarificationV2', 'structuredTaskReference', 'profilePreviewV1', 'profilePreview', 'profileHistory',
  'profilePublication', 'profileRoutingShadow', 'agentWorkDetailProjection',
]) assert.equal(stable.snapshot({ userId: 'user-a' })[key], true, `${key} must default on`);
assert.equal(stable.snapshot({ userId: 'user-a' }).profileRoutingAuto, false,
  'automatic recipient changes must require an explicit rollout decision');
assert.equal(stable.snapshot({ userId: 'user-a' }).boundedDeliveryReworkV1, true,
  'single and multi-user uBuddy tasks must share bounded delivery review by default');
assert.equal(stable.snapshot({ userId: 'user-a' }).boundedDeliveryRework, true);
assert.equal(stable.snapshot({ userId: 'user-a' }).continuousPlanningV1, true);
assert.equal(stable.snapshot({ userId: 'user-a' }).policies.continuousPlanningV1.source, 'hard_cutover');
settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({ ubuddy_continuous_planning_v1: 'off' }));
const continuousPlanningCutover = createUBuddyFeatureFlagService({
  store, env: { JANUS_UBUDDY_CONTINUOUS_PLANNING_V1: 'off' }, isDev: false,
}).snapshot({ userId: 'user-a' });
assert.equal(continuousPlanningCutover.continuousPlanningV1, true,
  'stored and environment rollout values must not disable the continuous-planning hard cutover');
assert.equal(continuousPlanningCutover.policies.continuousPlanningV1.source, 'hard_cutover');
settings.clear();
const emptyConfig = normalizeUBuddyFeatureFlagConfig({});
assert.equal(emptyConfig.ubuddy_profile_routing_auto_v1, 'off');
assert.equal(emptyConfig.bounded_delivery_rework_v1, 'on');

settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({
  'ubuddy.new_task_workspace_ui': 'off',
}));
const rolledBack = createUBuddyFeatureFlagService({ store, env: {}, isDev: false });
assert.equal(rolledBack.snapshot({ userId: 'user-a' }).newTaskWorkspaceUi, false);
assert.equal(rolledBack.snapshot({ userId: 'user-a' }).policies.newTaskWorkspaceUi.source, 'app_settings');
settings.clear();

settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({
  'ubuddy_profile_routing_auto_v1': false,
  'bounded_delivery_rework_v1': 0,
}));
const explicitlyDisabled = createUBuddyFeatureFlagService({ store, env: {}, isDev: false }).snapshot({ userId: 'user-a' });
assert.equal(explicitlyDisabled.profileRoutingAuto, false, 'a stored boolean false must remain an authoritative kill switch');
assert.equal(explicitlyDisabled.boundedDeliveryReworkV1, false, 'a stored numeric zero must remain an authoritative kill switch');
assert.equal(explicitlyDisabled.policies.profileRoutingAuto.source, 'app_settings');
settings.clear();

settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({
  'ubuddy.agent_work_detail_projection': 'on',
}));
assert.equal(createUBuddyFeatureFlagService({ store, env: {}, isDev: false })
  .snapshot({ userId: 'user-a' }).agentWorkDetailProjection, true,
  'the legacy Stage 8 flag key must remain readable');
settings.clear();

assert.equal(createUBuddyFeatureFlagService({
  store, env: { JANUS_UBUDDY_AGENT_WORK_DETAIL_PROJECTION: 'on' }, isDev: false,
}).snapshot({ userId: 'user-a' }).agentWorkDetailProjection, true);

settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({
  ubuddy_intake_clarification_v2: 'on',
}));
assert.equal(createUBuddyFeatureFlagService({ store, env: {}, isDev: false })
  .snapshot({ userId: 'user-a' }).intakeClarificationV2, true);
settings.clear();

const development = createUBuddyFeatureFlagService({ store, env: {}, isDev: true });
assert.equal(development.snapshot({ userId: 'user-a' }).newTaskWorkspaceUi, true);
assert.equal(development.snapshot({ userId: 'user-a' }).profilePreview, true);
assert.equal(development.snapshot({ userId: 'user-a' }).profilePreviewV1, true);
assert.equal(createUBuddyFeatureFlagService({ store, env: { NODE_ENV: 'test' }, isDev: false })
  .snapshot({ userId: 'user-a' }).boundedDeliveryRework, true);
assert.equal(createUBuddyFeatureFlagService({ store, env: { JANUS_BOUNDED_DELIVERY_REWORK_V1: 'on' }, isDev: false })
  .snapshot({ userId: 'user-a' }).boundedDeliveryReworkV1, true);

settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({
  'ubuddy.new_task_workspace_ui': 'on',
  'ubuddy.new_dispatch_strategy': 'percentage:25',
  'ubuddy.new_process_event_stream': 'off',
}));
const configured = createUBuddyFeatureFlagService({ store, env: {}, isDev: false });
const first = configured.snapshot({ userId: 'stable-bucket-user' });
const second = configured.snapshot({ userId: 'stable-bucket-user' });
assert.equal(first.newTaskWorkspaceUi, true);
assert.equal(first.newProcessEventStream, false);
assert.equal(first.policies.newDispatchStrategy.bucket, second.policies.newDispatchStrategy.bucket);
assert.equal(first.newDispatchStrategy, second.newDispatchStrategy);

const overridden = createUBuddyFeatureFlagService({
  store,
  env: { JANUS_UBUDDY_NEW_PROCESS_EVENT_STREAM: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' });
assert.equal(overridden.newProcessEventStream, true);
assert.equal(overridden.policies.newProcessEventStream.source, 'environment');

const futureFlag = createUBuddyFeatureFlagService({
  store,
  env: { JANUS_UBUDDY_PROFILE_ROUTING_SHADOW: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' });
assert.equal(futureFlag.profileRoutingShadow, true);
assert.equal(futureFlag.policies.profileRoutingShadow.flag, UBUDDY_FEATURE_FLAGS.profileRoutingShadow);
assert.equal(futureFlag.profileRoutingAuto, false);
assert.equal(createUBuddyFeatureFlagService({
  store, env: { JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1: 'on' }, isDev: false,
}).snapshot({ userId: 'user-a' }).profileRoutingAuto, true);
assert.equal(createUBuddyFeatureFlagService({
  store,
  env: { JANUS_UBUDDY_PROFILE_ROUTING_SHADOW_V1: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' }).profileRoutingShadow, true);
settings.set(UBUDDY_FEATURE_FLAG_SETTING_KEY, JSON.stringify({ 'ubuddy.profile_routing_shadow': 'on' }));
assert.equal(createUBuddyFeatureFlagService({ store, env: {}, isDev: false })
  .snapshot({ userId: 'user-a' }).profileRoutingShadow, true);
settings.clear();

const structuredReferenceFlag = createUBuddyFeatureFlagService({
  store,
  env: { JANUS_STRUCTURED_TASK_REFERENCE_V1: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' });
assert.equal(structuredReferenceFlag.structuredTaskReference, true);
assert.equal(structuredReferenceFlag.policies.structuredTaskReference.flag, 'structured_task_reference_v1');
assert.equal(createUBuddyFeatureFlagService({
  store,
  env: { JANUS_UBUDDY_STRUCTURED_TASK_REFERENCE: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' }).structuredTaskReference, true);
assert.equal(normalizeUBuddyFeatureFlagConfig({ 'ubuddy.structured_task_reference': 'on' })
  .structured_task_reference_v1, 'on');
assert.equal(normalizeUBuddyFeatureFlagConfig({ structured_task_reference_v1: false })
  .structured_task_reference_v1, 'off');

const previewFlag = createUBuddyFeatureFlagService({
  store,
  env: { JANUS_UBUDDY_PROFILE_PREVIEW_V1: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' });
assert.equal(previewFlag.profilePreviewV1, true);
assert.equal(previewFlag.policies.profilePreviewV1.flag, 'ubuddy_profile_preview_v1');

const profileHistoryFlag = createUBuddyFeatureFlagService({
  store,
  env: { JANUS_UBUDDY_PROFILE_HISTORY: 'on' },
  isDev: false,
}).snapshot({ userId: 'user-a' });
assert.equal(profileHistoryFlag.profileHistory, true);
assert.equal(profileHistoryFlag.policies.profileHistory.flag, 'ubuddy_profile_history_v1');

const previousRendererState = {
  messages: state.messages,
  collaborationGroupId: state.collaborationGroupId,
  networkConversationPeerId: state.networkConversationPeerId,
  activeTaskWorkspaceKind: state.activeTaskWorkspaceKind,
  uBuddyFeatureFlags: state.uBuddyFeatureFlags,
};
try {
  state.collaborationGroupId = '';
  state.networkConversationPeerId = '';
  state.activeTaskWorkspaceKind = '';
  state.messages = [{
    id: 'rollout-process-message', role: 'assistant', content: '完成',
    metadata: { processEvents: [{ activityId: 'rollout-command', activityType: 'command', status: 'completed', command: 'npm test' }] },
  }];
  state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, newProcessEventStream: false };
  assert.equal(renderChat().includes('codex-transcript'), false);
  state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, newProcessEventStream: true };
  assert.equal(renderChat().includes('codex-transcript'), true);
} finally {
  Object.assign(state, previousRendererState);
}

console.log('uBuddy rollout flags smoke passed');
