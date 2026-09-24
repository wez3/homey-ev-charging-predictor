'use strict';

const TimeSlots = require('./TimeSlots');
const { findLog } = require('./InsightsBackfill');

// Seeds the daily-energy model from Homey's own Insights history for the
// charger's cumulative energy meter, so the kWh prediction starts with real
// numbers instead of waiting to accrue a reading per day from scratch. Same
// access path the departure/arrival backfill relies on: a local app with the
// `homey:manager:api` permission can read any device's Insights log.
//
// Unlike the plug-state capability (an enum Insights won't log), `meter_power`
// is numeric, so this is usually a rich source: even a coarse bucket gives one
// usable cumulative reading per day, which is all the daily model needs.

const METER_CAPABILITY_ID = 'meter_power';
// Try longest-span first; the reading is a cumulative meter, so any bucket up
// to a day still yields one point per day. Whichever resolution gives the most
// days at roughly daily-or-finer spacing wins.
const RESOLUTIONS = ['lastYear', 'last31Days', 'last14Days'];
const MAX_MEDIAN_GAP_DAYS = 1.5;

/**
 * Collapse raw Insights entries to one cumulative reading per calendar day (in
 * `timeZone`) - the last of each day. Returns [{ day, meterKwh }] oldest-first.
 */
function toDailyReadings(values, timeZone) {
  const byDay = new Map();
  for (const entry of values) {
    const time = new Date(entry.t);
    const v = entry.v !== undefined ? entry.v : entry.y;
    if (Number.isNaN(time.getTime()) || typeof v !== 'number') continue;
    const day = TimeSlots.dayKey(time, timeZone);
    const cur = byDay.get(day);
    if (!cur || time.getTime() >= cur.t) byDay.set(day, { t: time.getTime(), v });
  }
  return [...byDay.entries()]
    .map(([day, o]) => ({ day, meterKwh: o.v }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function medianGapDays(readings) {
  const gaps = [];
  for (let i = 1; i < readings.length; i++) {
    gaps.push(TimeSlots.dayKeyDiff(readings[i - 1].day, readings[i].day));
  }
  if (gaps.length === 0) return Infinity;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Returns { readings: [{ day, meterKwh }], resolution, days } - the best
 * available daily reading series - or { readings: [], resolution: null,
 * days: 0 } if none is usable. Any failure degrades to empty; the app then
 * just accrues readings live going forward.
 */
async function backfillDailyReadings(api, { deviceId, timeZone }) {
  const empty = { readings: [], resolution: null, days: 0 };
  try {
    let allLogs = await api.insights.getLogs().catch(() => []);
    if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs || {});

    const log = findLog(allLogs, deviceId, METER_CAPABILITY_ID);
    if (!log) return empty;

    let best = empty;
    for (const resolution of RESOLUTIONS) {
      const result = await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
      const values = result && Array.isArray(result.values) ? result.values : [];
      if (values.length < 2) continue;

      const readings = toDailyReadings(values, timeZone);
      if (readings.length < 3) continue;
      if (medianGapDays(readings) > MAX_MEDIAN_GAP_DAYS) continue; // too coarse for daily deltas

      if (readings.length > best.readings.length) {
        best = { readings, resolution, days: readings.length };
      }
    }
    return best;
  } catch (err) {
    return empty;
  }
}

module.exports = { backfillDailyReadings, toDailyReadings, medianGapDays };
