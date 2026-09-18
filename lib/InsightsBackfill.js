'use strict';

const { detectTransitions } = require('./EdgeDetector');

/**
 * One-time backfill from Homey's own Insights history for the bound charger
 * state capability, so predictions can start using real history instead of
 * waiting weeks to accumulate events from scratch - if that history exists.
 * Verified against the real com.gruijter.powerhour app: a local app with
 * `homey:manager:api` permission can read ANY device's Insights log via
 * `api.insights.getLogs()` / `api.insights.getLogEntries({ id })`, not just
 * its own.
 *
 * In practice this will usually find nothing for a charger's connection-state
 * capability: Homey Insights only logs number/boolean values, and this
 * capability is an enum (e.g. `evcharger_charging_state`) - so unless that
 * changes, this is here for forward-compatibility more than as a reliable
 * source of history today. Any failure (no permission, log not found, wrong
 * type, empty history) just yields an empty array; the app falls back to
 * collecting events live going forward, exactly as if this had not run.
 */

// The history equivalent of the live path's debounce. Hourly buckets are
// averages, so the hour containing a departure reads somewhere between "idle
// but connected" and zero - which can cross the plugged/unplugged threshold
// back and forth and fake an "arrived, then left again" pair around the one
// real departure. Confirmed on real data: 14 days yielded 22 events raw but
// only 14 once blips shorter than this were collapsed. A car that unplugs and
// replugs inside 90 minutes has not departed in any sense a charging schedule
// cares about either way.
const BACKFILL_MIN_DWELL_MS = 90 * 60 * 1000;

function findLog(allLogs, deviceId, capabilityId) {
  const logs = Array.isArray(allLogs) ? allLogs : Object.values(allLogs || {});
  return logs.find((log) => {
    const logId = log.id || log.uri || '';
    return logId.includes(deviceId) && logId.endsWith(`:${capabilityId}`);
  });
}

/**
 * Returns [{ direction: 'arrival'|'departure', time: Date }], oldest first.
 */
async function backfillEvents(api, { deviceId, capabilityId, awayValues }) {
  try {
    let allLogs = await api.insights.getLogs().catch(() => []);
    if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs || {});

    const log = findLog(allLogs, deviceId, capabilityId);
    if (!log) return [];

    const result = await api.insights.getLogEntries({ id: log.id }).catch(() => null);
    const values = result && Array.isArray(result.values) ? result.values : [];
    if (values.length === 0) return [];

    const away = Array.isArray(awayValues) ? awayValues : [];

    const samples = values
      .map((entry) => {
        const time = new Date(entry.t);
        const rawValue = entry.v !== undefined ? entry.v : entry.y;
        if (Number.isNaN(time.getTime())) return null;
        return { time, present: !away.includes(rawValue) };
      })
      .filter(Boolean);

    return detectTransitions(samples, { minDwellMs: BACKFILL_MIN_DWELL_MS });
  } catch (err) {
    return [];
  }
}

// Insights buckets coarser than this lose too much precision to be worth
// training on - a departure placed +/- 3h is worse than no departure at all.
const MAX_USEFUL_BUCKET_MS = 70 * 60 * 1000;

// Homey's Insights API has no date-range paging at all - `getLogEntries`
// accepts only `id`/`uri`/`resolution` (confirmed in Homey's own local API
// spec), so the only lever is which named resolution to ask for. Homey then
// picks the bucket size to fit that span. Measured against a real charger:
//
//   last7Days / lastWeek / thisWeek   1h buckets, ~7 days each
//   last14Days                        1h buckets, 14 days (336 entries)
//   last31Days / lastMonth            6h buckets
//
// So 14 days is the ceiling at usable precision, and `last14Days` gets there
// in one call - it ends at the current hour, so it subsumes all three of the
// week-sized windows this used to stitch together (~11.5 days).
//
// `last7Days` is kept purely as insurance: windows are merged (overlapping
// duplicate timestamps are dropped) and any window coarser than
// MAX_USEFUL_BUCKET_MS is rejected, so on a firmware where `last14Days` ever
// came back coarser we silently degrade to the old 7-day behaviour instead of
// training on badly-timed events.
const FINE_WINDOWS = ['last14Days', 'last7Days'];

function medianBucketMs(values) {
  const gaps = [];
  for (let i = 1; i < values.length; i++) {
    const gap = new Date(values[i].t).getTime() - new Date(values[i - 1].t).getTime();
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return Infinity;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Backfill from a numeric capability that reveals plug state (see
 * ChargerProfiles). The bound enum state capability can never be
 * backfilled - Homey Insights only logs numbers and booleans - so without this
 * a freshly paired device starts from zero history even when the charger has
 * months of perfectly usable data recorded.
 *
 * Prefers the longest span whose buckets are still fine-grained enough to time
 * a departure usefully, falling back to a shorter, finer resolution.
 */
async function backfillFromNumericSource(api, { deviceId, sources }) {
  const empty = {
    events: [], capabilityId: null, windows: [], spanDays: 0,
  };
  try {
    let allLogs = await api.insights.getLogs().catch(() => []);
    if (!Array.isArray(allLogs)) allLogs = Object.values(allLogs || {});

    for (const { capabilityId, pluggedAbove } of sources) {
      const log = findLog(allLogs, deviceId, capabilityId);
      if (!log) continue;

      const byTime = new Map();
      const windows = [];

      for (const resolution of FINE_WINDOWS) {
        const result = await api.insights.getLogEntries({ id: log.id, resolution }).catch(() => null);
        const values = result && Array.isArray(result.values) ? result.values : [];
        if (values.length < 2) continue;
        if (medianBucketMs(values) > MAX_USEFUL_BUCKET_MS) continue;

        windows.push(resolution);
        for (const entry of values) {
          const time = new Date(entry.t);
          const raw = entry.v !== undefined ? entry.v : entry.y;
          if (Number.isNaN(time.getTime()) || typeof raw !== 'number') continue;
          if (!byTime.has(time.getTime())) byTime.set(time.getTime(), { time, present: raw > pluggedAbove });
        }
      }

      if (byTime.size < 2) continue;
      const samples = [...byTime.values()].sort((a, b) => a.time - b.time);
      const events = detectTransitions(samples, { minDwellMs: BACKFILL_MIN_DWELL_MS });
      if (events.length === 0) continue;

      const spanDays = (samples[samples.length - 1].time - samples[0].time) / 86400000;
      return {
        events, capabilityId, windows, spanDays: Math.round(spanDays * 10) / 10,
      };
    }
    return empty;
  } catch (err) {
    return empty;
  }
}

module.exports = { findLog, backfillEvents, backfillFromNumericSource };
