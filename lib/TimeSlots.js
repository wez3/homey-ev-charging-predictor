'use strict';

/**
 * Time-of-day helpers, evaluated in an explicit IANA timezone.
 *
 * A Homey app process does NOT run in the timezone configured in Homey's
 * settings: the app sandbox is started without a TZ, so `new Date().getHours()`
 * returns container time (UTC), not the user's wall clock. That is exactly why
 * the SDK exposes `this.homey.clock.getTimezone()` - and its own default is
 * 'UTC'. Deriving wall-clock values from the process clock therefore produced a
 * displayed departure time offset from reality by the user's UTC offset, which
 * no longer matched the "minutes until" value beside it (that one is a plain
 * timestamp difference, so it was always right).
 *
 * It also mis-filed events near midnight: a 00:30 local departure is 22:30 UTC
 * the *previous* day, so it was learned against the wrong weekday.
 */

const partsCache = new Map();

function formatterFor(timeZone) {
  let dtf = partsCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(timeZone, dtf);
  }
  return dtf;
}

const WEEKDAY_INDEX = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * The wall-clock fields of `date` as seen in `timeZone`.
 * Returns { year, month (1-12), day, weekday (0=Sun), hours, minutes, seconds }.
 */
function partsInZone(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_INDEX[parts.weekday],
    // 'en-US' with hour12:false renders midnight as 24; normalise it.
    hours: Number(parts.hour) % 24,
    minutes: Number(parts.minute),
    seconds: Number(parts.second),
  };
}

/**
 * How far `timeZone` is ahead of UTC at this instant, in milliseconds.
 */
function zoneOffsetMs(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hours, p.minutes, p.seconds);
  // Discard sub-second detail so the subtraction is exact.
  return asIfUtc - (Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * The instant at which `timeZone`'s wall clock reads the given date and time.
 *
 * Done in two passes because the offset depends on the instant we are trying to
 * find: the first pass guesses using the offset at the naive timestamp, the
 * second corrects it if that guess landed on the other side of a DST change.
 */
function instantFromWallClock({
  year, month, day, hours, minutes,
}, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

function getWeekdayAndMinutes(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return { weekday: p.weekday, minuteOfDay: p.hours * 60 + p.minutes };
}

/**
 * The weekday `addDays` calendar days after `now`, in `timeZone`.
 */
function weekdayOnDayOffset(now, addDays, timeZone) {
  const p = partsInZone(now, timeZone);
  // Date.UTC normalises overflowing day numbers for us.
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays, 12));
  return shifted.getUTCDay();
}

/**
 * The instant `addDays` calendar days from `now` at `minuteOfDay` of
 * `timeZone`'s wall clock. Pinned to that specific day, so a caller walking day
 * offsets gets "tomorrow" rather than jumping a week ahead to the next
 * occurrence of the same weekday.
 */
function dateOnDayOffset(now, addDays, minuteOfDay, timeZone) {
  if (minuteOfDay == null || Number.isNaN(minuteOfDay)) return null;
  const p = partsInZone(now, timeZone);
  const target = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays, 12));
  return instantFromWallClock({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hours: Math.floor(minuteOfDay / 60) % 24,
    minutes: Math.round(minuteOfDay % 60),
  }, timeZone);
}

function formatTime(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`;
}

/**
 * A sortable 'YYYY-MM-DD' key for the calendar day `date` falls on in
 * `timeZone`. Zero-padded so lexical order matches chronological order.
 */
function dayKey(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The 'YYYY-MM-DD' day key `addDays` calendar days after `now`, in `timeZone`.
 * Built the same way as weekdayOnDayOffset, so the two always agree on which
 * calendar day an offset lands on.
 */
function dayKeyOnDayOffset(now, addDays, timeZone) {
  const p = partsInZone(now, timeZone);
  const s = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays, 12));
  return `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The weekday (0=Sun..6=Sat) of a 'YYYY-MM-DD' day key. Parsed at UTC noon so
 * it is independent of any timezone or DST edge.
 */
function weekdayOfDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/**
 * Whole calendar days from day key `a` to `b` (b - a). 1 for consecutive days.
 */
function dayKeyDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

module.exports = {
  partsInZone,
  zoneOffsetMs,
  getWeekdayAndMinutes,
  weekdayOnDayOffset,
  dateOnDayOffset,
  formatTime,
  dayKey,
  dayKeyOnDayOffset,
  weekdayOfDayKey,
  dayKeyDiff,
};
