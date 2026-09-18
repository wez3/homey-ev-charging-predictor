'use strict';

/**
 * Time-of-day helpers. Deliberately uses the Homey process's local system time
 * (not a timezone-aware Intl conversion) since Homey Pro's OS clock is already
 * kept in sync with the timezone configured in Homey's own settings.
 */

function getWeekdayAndMinutes(date) {
  return { weekday: date.getDay(), minuteOfDay: date.getHours() * 60 + date.getMinutes() };
}

/**
 * Returns the next Date (strictly after `now`) that falls on `targetWeekday`
 * (0 = Sunday) at `targetMinuteOfDay` (minutes since local midnight), or null
 * if targetMinuteOfDay is invalid.
 */
function nextOccurrenceDate(now, targetWeekday, targetMinuteOfDay) {
  if (targetMinuteOfDay == null || Number.isNaN(targetMinuteOfDay)) return null;
  const hours = Math.floor(targetMinuteOfDay / 60) % 24;
  const minutes = Math.round(targetMinuteOfDay % 60);

  for (let addDays = 0; addDays <= 7; addDays++) {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + addDays,
      hours,
      minutes,
      0,
      0,
    );
    if (candidate.getDay() === targetWeekday && candidate.getTime() > now.getTime()) {
      return candidate;
    }
  }
  return null;
}

/**
 * The Date `addDays` calendar days from `now`, at `minuteOfDay` local time.
 * Unlike nextOccurrenceDate this pins the result to that specific day, so a
 * caller walking day offsets gets "tomorrow" rather than jumping a whole week
 * ahead to the next occurrence of the same weekday.
 */
function dateOnDayOffset(now, addDays, minuteOfDay) {
  if (minuteOfDay == null || Number.isNaN(minuteOfDay)) return null;
  const hours = Math.floor(minuteOfDay / 60) % 24;
  const minutes = Math.round(minuteOfDay % 60);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays, hours, minutes, 0, 0);
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

module.exports = {
  getWeekdayAndMinutes, nextOccurrenceDate, dateOnDayOffset, formatTime,
};
