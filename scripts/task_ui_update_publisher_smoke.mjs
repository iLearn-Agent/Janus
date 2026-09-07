import assert from 'node:assert/strict';

import {
  createTaskUiUpdatePublisher,
  taskUpdateAffectsAvailability,
  taskUpdateCanCoalesce,
} from '../src/main/taskUiUpdatePublisher.js';

const timers = [];
const published = [];
const publisher = createTaskUiUpdatePublisher({
  delayMs: 250,
  publish: (payload, metadata) => published.push({ payload, metadata }),
  setTimer: (callback, delayMs) => {
    const timer = { callback, delayMs, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  },
  clearTimer: (timer) => { timer.cleared = true; },
});

const progress = (taskId, sequence) => ({
  task: { id: taskId, status: 'running', sequence },
  change: { type: 'node_activity', sequence },
});

assert.equal(taskUpdateCanCoalesce(progress('task-a', 1)), true);
assert.equal(taskUpdateAffectsAvailability(progress('task-a', 1)), false);
publisher.enqueue(progress('task-a', 1));
publisher.enqueue(progress('task-a', 2));
publisher.enqueue(progress('task-a', 3));
publisher.enqueue(progress('task-b', 1));
assert.equal(publisher.pendingCount(), 2);
assert.equal(timers.length, 2, 'each task should own one UI update timer');

timers[0].callback();
assert.equal(published.length, 1);
assert.equal(published[0].payload.task.sequence, 3, 'coalescing must publish the latest task snapshot');
assert.equal(published[0].metadata.coalescedCount, 3);

publisher.enqueue(progress('task-b', 2));
const completed = { task: { id: 'task-b', status: 'completed' }, change: { type: 'node_completed' } };
assert.equal(taskUpdateAffectsAvailability(completed), true);
publisher.enqueue(completed);
assert.equal(published.length, 2, 'terminal updates must publish immediately');
assert.equal(published[1].payload.change.type, 'node_completed');
assert.equal(published[1].metadata.coalescedCount, 3, 'terminal update should supersede queued progress');
assert.equal(publisher.pendingCount(), 0);

for (const timer of timers) if (!timer.cleared) timer.callback();
assert.equal(published.length, 2, 'superseded timers must not publish stale progress');
publisher.close();

const publicationErrors = [];
const failingTimers = [];
const failingPublisher = createTaskUiUpdatePublisher({
  publish: () => { throw new Error('simulated publication failure'); },
  onError: (error, metadata) => publicationErrors.push({ error, metadata }),
  setTimer: (callback) => {
    const timer = { callback, unref() {} };
    failingTimers.push(timer);
    return timer;
  },
  clearTimer: () => {},
});
assert.doesNotThrow(() => failingPublisher.enqueue({ task: { id: 'task-error' }, change: { type: 'node_completed' } }));
failingPublisher.enqueue(progress('task-error-delayed', 1));
assert.doesNotThrow(() => failingTimers[0].callback());
assert.equal(publicationErrors.length, 2, 'both immediate and delayed publication failures must be contained');
failingPublisher.close();

const synchronousPublications = [];
const synchronousPublisher = createTaskUiUpdatePublisher({
  publish: (payload) => synchronousPublications.push(payload),
  setTimer: (callback) => { callback(); return { unref() {} }; },
  clearTimer: () => {},
});
synchronousPublisher.enqueue(progress('task-synchronous-timer', 1));
assert.equal(synchronousPublications.length, 1,
  'publisher must remain correct when a test or scheduler invokes the timer callback synchronously');
assert.equal(synchronousPublisher.pendingCount(), 0);
console.log('Task UI update publisher smoke passed.');
