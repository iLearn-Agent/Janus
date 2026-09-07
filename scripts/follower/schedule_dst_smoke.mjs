import assert from 'node:assert/strict';

import { followerWindow, localDateTimeToUtc, zonedParts } from '../../src/main/modules/follower/domain/timeWindow.js';
import { followerOccurrenceKey, followerScheduledWindow, nextFollowerOccurrence } from '../../src/main/modules/follower/domain/schedule.js';

const skipped = localDateTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York');
assert.deepEqual(zonedParts(skipped, 'America/New_York'), { year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0 });
const folded = localDateTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, 'America/New_York');
assert.equal(folded.toISOString(), '2026-11-01T05:30:00.000Z');

const schedule = { id: 'schedule:daily', revision: 2, kind: 'daily_brief', timezone: 'America/New_York', frequency: 'daily', daysOfWeek: [7], localTime: '02:30' };
const occurrence = nextFollowerOccurrence(schedule, { after: new Date('2026-03-07T12:00:00.000Z') });
assert.equal(occurrence.toISOString(), '2026-03-08T07:00:00.000Z');
assert.match(followerOccurrenceKey(schedule, occurrence), /schedule%3Adaily:2:2026-03-08T07:00:00\.000Z/);
const window = followerScheduledWindow(schedule, { occurrence, now: new Date('2026-03-08T07:05:00.000Z'), lastSuccessWindowEnd: '2026-02-01T00:00:00.000Z' });
assert.equal(window.catchUp, true);
assert.equal(window.truncated, true);

const shanghai = followerWindow('daily_brief', { now: new Date('2026-08-12T12:00:00.000Z'), timezone: 'Asia/Shanghai' });
assert.equal(shanghai.startAt, '2026-08-11T16:00:00.000Z');
console.log('Follower schedule DST smoke passed');
