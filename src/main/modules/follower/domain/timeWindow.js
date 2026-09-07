export function followerWindow(kind = 'daily_brief', { now = new Date(), timezone = 'Asia/Shanghai' } = {}) {
  const end = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(end.getTime())) throw new Error('Invalid Follower window end.');
  if (kind === 'growth_guidance') {
    return { startAt: new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(), endAt: end.toISOString(), timezone };
  }
  const parts = zonedParts(end, timezone);
  if (kind === 'weekly_review') {
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() || 7;
    const monday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - weekday + 1));
    return {
      startAt: localDateTimeToUtc({ year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate(), hour: 0, minute: 0, second: 0 }, timezone).toISOString(),
      endAt: end.toISOString(), timezone,
    };
  }
  return {
    startAt: localDateTimeToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timezone).toISOString(),
    endAt: end.toISOString(), timezone,
  };
}

export function localDateTimeToUtc(parts, timezone) {
  const desiredClock = (parts.hour || 0) * 60 + (parts.minute || 0);
  const center = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
  const exact = [];
  const later = [];
  for (let value = center - 14 * 60 * 60 * 1000; value <= center + 14 * 60 * 60 * 1000; value += 60_000) {
    const actual = zonedParts(new Date(value), timezone);
    if (actual.year !== parts.year || actual.month !== parts.month || actual.day !== parts.day) continue;
    const clock = actual.hour * 60 + actual.minute;
    if (clock === desiredClock && actual.second === (parts.second || 0)) exact.push(value);
    else if (clock > desiredClock) later.push({ value, clock });
  }
  if (exact.length) return new Date(Math.min(...exact));
  later.sort((left, right) => left.clock - right.clock || left.value - right.value);
  if (later.length) return new Date(later[0].value);
  throw new Error(`Local time does not exist in ${timezone}.`);
}

export function zonedParts(date, timezone) {
  const entries = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(entries.map((item) => [item.type, item.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}
