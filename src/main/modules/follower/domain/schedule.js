import { followerWindow, localDateTimeToUtc, zonedParts } from './timeWindow.js';

export function nextFollowerOccurrence(schedule = {}, { after = new Date() } = {}) {
  const start = after instanceof Date ? new Date(after.getTime()) : new Date(after);
  const timezone = schedule.timezone || 'Asia/Shanghai';
  const [hour, minute] = String(schedule.localTime || '09:00').split(':').map(Number);
  const allowedDays = new Set((Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : []).map(Number));
  const local = zonedParts(start, timezone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const weekday = day.getUTCDay() || 7;
    if (allowedDays.size && !allowedDays.has(weekday)) continue;
    const candidate = localDateTimeToUtc({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute, second: 0 }, timezone);
    if (candidate.getTime() > start.getTime()) return candidate;
  }
  return null;
}

export function followerOccurrenceKey(schedule, occurrence) {
  return `${encodeURIComponent(schedule.id)}:${Math.max(1, Number(schedule.revision || 1))}:${occurrence.toISOString()}`;
}

export function followerScheduledWindow(schedule, { occurrence = new Date(), now = new Date(), lastSuccessWindowEnd = '' } = {}) {
  const kind = schedule.kind || 'daily_brief';
  const current = followerWindow(kind, { now, timezone: schedule.timezone || 'Asia/Shanghai' });
  const lastSuccess = Date.parse(lastSuccessWindowEnd || '');
  const limitDays = kind === 'weekly_review' ? 35 : kind === 'growth_guidance' ? 14 : 7;
  const minimum = now.getTime() - limitDays * 24 * 60 * 60 * 1000;
  const start = Number.isFinite(lastSuccess) ? Math.max(lastSuccess, minimum) : Date.parse(current.startAt);
  return {
    ...current,
    startAt: new Date(Math.min(start, now.getTime())).toISOString(),
    catchUp: occurrence.getTime() + 60_000 < now.getTime(),
    truncated: Number.isFinite(lastSuccess) && lastSuccess < minimum,
  };
}
