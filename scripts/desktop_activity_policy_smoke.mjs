import assert from 'node:assert/strict';

import {
  DESKTOP_ACTIVITY_STATE,
  deriveDesktopActivityState,
  desktopLoopDelay,
  shouldQuitWhenAllWindowsClosed,
  socialPollHadActivity,
  taskUpdateRequiresImmediateSocialPoll,
  uBuddyRecoveryDelay,
} from '../src/main/desktopActivityPolicy.js';

assert.equal(deriveDesktopActivityState({ suspended: true, hasVisibleWindow: true, hasBackgroundWork: true }), DESKTOP_ACTIVITY_STATE.SUSPENDED);
assert.equal(deriveDesktopActivityState({ hasVisibleWindow: true }), DESKTOP_ACTIVITY_STATE.FOREGROUND);
assert.equal(deriveDesktopActivityState({ hasVisibleWindow: true, locked: true, hasBackgroundWork: true }), DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK);
assert.equal(deriveDesktopActivityState({ hasBackgroundWork: true }), DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK);
assert.equal(deriveDesktopActivityState({}), DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE);
assert.equal(shouldQuitWhenAllWindowsClosed('darwin'), false);
assert.equal(shouldQuitWhenAllWindowsClosed('win32'), true);
assert.equal(shouldQuitWhenAllWindowsClosed('linux'), true);
assert.equal(shouldQuitWhenAllWindowsClosed('win32', { keepAlive: true, closeBehavior: 'background' }), false);
assert.equal(shouldQuitWhenAllWindowsClosed('darwin', { closeBehavior: 'quit' }), true);

assert.equal(desktopLoopDelay('social', { state: DESKTOP_ACTIVITY_STATE.FOREGROUND }), 10_000);
assert.equal(desktopLoopDelay('social', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK }), 15_000);
assert.deepEqual([0, 1, 2, 3, 9].map((idleRounds) => desktopLoopDelay('social', {
  state: DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE, idleRounds,
})), [30_000, 60_000, 120_000, 300_000, 300_000]);
assert.equal(desktopLoopDelay('social', { state: DESKTOP_ACTIVITY_STATE.SUSPENDED }), null);
assert.equal(desktopLoopDelay('task_recovery', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE, configuredMs: 5_000 }), null);
assert.equal(desktopLoopDelay('maintenance', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE, onBattery: true }), null);
assert.equal(desktopLoopDelay('maintenance', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE, onBattery: false }), 15 * 60_000);
assert.equal(desktopLoopDelay('cloud_sync', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE, onBattery: true }), 30 * 60_000);

assert.equal(uBuddyRecoveryDelay('allocation', { state: DESKTOP_ACTIVITY_STATE.FOREGROUND, configuredMs: 5_000 }), 5_000);
assert.equal(uBuddyRecoveryDelay('allocation', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK, configuredMs: 5_000 }), 15_000);
assert.equal(uBuddyRecoveryDelay('allocation', { state: DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE, configuredMs: 5_000 }), 5 * 60_000);
assert.equal(uBuddyRecoveryDelay('allocation', { state: DESKTOP_ACTIVITY_STATE.SUSPENDED, configuredMs: 5_000 }), null);

assert.equal(socialPollHadActivity({ skipped: true, messages: 1 }), false);
assert.equal(socialPollHadActivity({ messages: 1 }), true);
assert.equal(socialPollHadActivity({ collaboration: { tasks: [{ status: 'closed' }] } }), false);
assert.equal(socialPollHadActivity({ collaboration: { tasks: [{ status: 'running' }] } }), true);

const intakeCompletedUpdate = {
  delegation: {
    id: 'delegation-ready-for-background-start', status: 'accepted', taskRunId: '',
    metadata: { intakeStatus: 'completed', dependencyState: 'not_required' },
  },
  change: { type: 'delegation_progress', progressEventKey: 'intake_completed' },
};
assert.equal(taskUpdateRequiresImmediateSocialPoll(intakeCompletedUpdate), true);
assert.equal(taskUpdateRequiresImmediateSocialPoll({
  ...intakeCompletedUpdate,
  change: { type: 'delegation_progress', progressEventKey: 'intake_started' },
}), false);
assert.equal(taskUpdateRequiresImmediateSocialPoll({
  ...intakeCompletedUpdate,
  delegation: { ...intakeCompletedUpdate.delegation, taskRunId: 'task-already-created' },
}), false);
assert.equal(taskUpdateRequiresImmediateSocialPoll({
  ...intakeCompletedUpdate,
  delegation: {
    ...intakeCompletedUpdate.delegation,
    metadata: { ...intakeCompletedUpdate.delegation.metadata, dependencyState: 'waiting' },
  },
}), false);

console.log('desktop activity policy smoke passed');
