import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DESKTOP_ACTIVITY_STATE } from '../src/main/desktopActivityPolicy.js';
import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-desktop-activity-'));
let runtime = null;
const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

try {
  runtime = await createRuntime({ root, isDev: true });
  await wait(100);
  const user = runtime.currentUser();
  const powerTask = runtime.store.createTaskRun({
    id: 'desktop-power-transition-task', ownerUserId: user.id,
    title: 'Desktop power transition task', prompt: 'Track suspend and resume.',
  });
  assert.equal(runtime.recordDesktopPowerTransition({
    state: 'suspended', occurredAt: '2026-08-17T01:00:00.000Z',
  }).recorded, 1);
  assert.equal(runtime.recordDesktopPowerTransition({
    state: 'resumed', occurredAt: '2026-08-17T01:05:00.000Z', suspendedDurationMs: 300_000,
  }).recorded, 1);
  const powerEvents = runtime.store.getTaskRun(powerTask.id).events;
  assert.ok(powerEvents.some((event) => event.eventType === 'task_paused_system_suspend'));
  assert.equal(powerEvents.find((event) => event.eventType === 'task_resumed_system_resume')?.payload?.suspendedDurationMs, 300_000);
  const originalMatch = runtime.store.matchWaitingUBuddyAgentRequests.bind(runtime.store);
  let allocationSweepCount = 0;
  runtime.store.matchWaitingUBuddyAgentRequests = (...args) => {
    allocationSweepCount += 1;
    return originalMatch(...args);
  };

  runtime.setDesktopActivityState(DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE);
  await wait(1_100);
  assert.equal(allocationSweepCount, 0, 'background-idle runtime must not keep the former five-second uBuddy sweep active');

  runtime.setDesktopActivityState(DESKTOP_ACTIVITY_STATE.SUSPENDED);
  await wait(50);
  assert.equal(allocationSweepCount, 0, 'suspended runtime must keep uBuddy recovery paused');

  runtime.setDesktopActivityState(DESKTOP_ACTIVITY_STATE.FOREGROUND);
  await wait(100);
  assert.ok(allocationSweepCount >= 1, 'resume must immediately re-arm uBuddy recovery');

  console.log('runtime desktop activity smoke passed');
} finally {
  await Promise.resolve(runtime?.close?.()).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
