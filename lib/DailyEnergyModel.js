'use strict';

const TimeSlots = require('./TimeSlots');

// Predicts how many kWh the car will need on a typical upcoming day, from a
// log of daily cumulative-meter readings:
//   [{ day: 'YYYY-MM-DD' (Homey timezone), meterKwh: <cumulative reading> }]
// One entry per day, the last reading of that day winning (so a completed day
// holds its end-of-day total). The energy used on a day is the rise in the
// cumulative meter across it - the difference between consecutive days.
//
// Why per-day rather than per plug-in/out session: a home charger is often
// left connected for days and tops up in bursts (smart charging on cheap
// hours), so "energy between plugging in and unplugging" is an unstable unit -
// a session can span a multi-day stint or be a tiny tail. Energy per calendar
// day is what a day-ahead energy plan actually needs, and it is well defined
// whether or not the cable was ever unplugged.
//
// The estimate mirrors the departure/arrival model's philosophy: a robust,
// recency-weighted central value, reported with a 10th-90th-percentile band so
// the interesting HEMS decisions (worth running the cheap-hours plan? how much
// margin to keep?) can be made on the spread, not just the point.

const HALF_LIFE_DAYS = 30;
// A day physically can't add more than a charger's worth of kWh; past this it's
// a meter reset, a unit glitch, or a gap counted as one day.
const MAX_DAILY_KWH = 150;
const TARGET_EFFECTIVE_N = 10;
const SPREAD_REF_KWH = 5;
const LOW_PCT = 0.1;
const HIGH_PCT = 0.9;
// Shrinkage constant for blending a target weekday's own history with the
// pooled all-days estimate. The weekday's share is n_eff / (n_eff + K), so at
// K=3 a weekday needs ~3 effective days to carry half the weight - enough to
// show a real weekly pattern without over-fitting three noisy Thursdays.
const WEEKDAY_SHRINKAGE_K = 3;

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

function weightedPercentile(sorted, p) {
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return null;
  const target = p * total;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prevCum = cum;
    cum += sorted[i].weight;
    if (cum >= target) {
      if (i === 0) return sorted[0].value;
      const frac = (target - prevCum) / sorted[i].weight;
      return sorted[i - 1].value + frac * (sorted[i].value - sorted[i - 1].value);
    }
  }
  return sorted[sorted.length - 1].value;
}

// Robust weighted summary of a set of { value, weight } items.
function weightedStats(items) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const sumW = sorted.reduce((s, x) => s + x.weight, 0);
  const sumW2 = sorted.reduce((s, x) => s + x.weight * x.weight, 0);
  return {
    median: weightedPercentile(sorted, 0.5),
    low: weightedPercentile(sorted, LOW_PCT),
    high: weightedPercentile(sorted, HIGH_PCT),
    nEff: sumW2 > 0 ? (sumW * sumW) / sumW2 : 0,
  };
}

class DailyEnergyModel {
  /**
   * Daily energy totals from the meter-day log. Returns
   * [{ day, weekday, kwh }] oldest-first. A day is included only when the
   * previous stored day is exactly one calendar day earlier (so a gap from
   * downtime isn't billed as one giant day) and the rise is non-negative and
   * plausible (a meter reset or glitch is dropped, not guessed).
   * `excludeDay` (a 'YYYY-MM-DD' key, normally today) is never emitted as a
   * total, because the current day is still accumulating and would read low.
   */
  static dailyTotals(meterDayLog, { excludeDay = null } = {}) {
    const log = (meterDayLog || [])
      .filter((e) => e && typeof e.day === 'string' && typeof e.meterKwh === 'number')
      .slice()
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    const totals = [];
    for (let i = 1; i < log.length; i++) {
      const prev = log[i - 1];
      const cur = log[i];
      if (cur.day === excludeDay) continue;
      if (TimeSlots.dayKeyDiff(prev.day, cur.day) !== 1) continue; // gap - can't attribute
      const kwh = cur.meterKwh - prev.meterKwh;
      if (kwh < 0 || kwh > MAX_DAILY_KWH) continue; // reset / glitch
      totals.push({ day: cur.day, weekday: TimeSlots.weekdayOfDayKey(cur.day), kwh });
    }
    return totals;
  }

  /**
   * Predict the energy need for a specific upcoming day.
   * Returns { expectedKwh, lowKwh, highKwh, confidence, sampleCount,
   * weekdaySampleCount, targetWeekday, weekdayShare, source }. Nulls and source
   * 'none' when there is no usable history yet.
   *
   * When `targetWeekday` (0=Sun..6=Sat) is given, the estimate is conditioned
   * on that weekday so weekly patterns show (a commuting Thursday reads higher
   * than a quiet Sunday). It shrinks toward the pooled all-days estimate by how
   * much same-weekday history exists (`weekdayShare` = that weekday's weight),
   * so a weekday with few days doesn't over-fit and one with none falls back to
   * pooled cleanly. Omit `targetWeekday` for the pooled "typical day" estimate.
   */
  static predict(meterDayLog, now = new Date(), { timeZone = 'UTC', targetWeekday = null } = {}) {
    const excludeDay = TimeSlots.dayKey(now, timeZone);
    const totals = DailyEnergyModel.dailyTotals(meterDayLog, { excludeDay });
    if (totals.length === 0) {
      return {
        expectedKwh: null,
        lowKwh: null,
        highKwh: null,
        confidence: 0,
        sampleCount: 0,
        weekdaySampleCount: 0,
        targetWeekday,
        weekdayShare: 0,
        source: 'none',
      };
    }

    const weighted = totals.map((t) => ({
      value: t.kwh,
      weekday: t.weekday,
      weight: Math.pow(0.5, Math.max(0, TimeSlots.dayKeyDiff(t.day, excludeDay)) / HALF_LIFE_DAYS),
    }));

    const pooled = weightedStats(weighted);

    // Blend the target weekday's own history with the pooled estimate. With no
    // target, or no days for it, alpha is 0 and this is exactly the pooled
    // estimate.
    const weekdayItems = targetWeekday == null
      ? []
      : weighted.filter((x) => x.weekday === targetWeekday);
    const weekday = weekdayItems.length > 0 ? weightedStats(weekdayItems) : null;
    const alpha = weekday ? weekday.nEff / (weekday.nEff + WEEKDAY_SHRINKAGE_K) : 0;

    const blend = (w, p) => (weekday ? alpha * w + (1 - alpha) * p : p);
    const expected = blend(weekday && weekday.median, pooled.median);
    const low = blend(weekday && weekday.low, pooled.low);
    const high = blend(weekday && weekday.high, pooled.high);
    const nEffUsed = blend(weekday && weekday.nEff, pooled.nEff);

    const sizeScore = Math.min(1, nEffUsed / TARGET_EFFECTIVE_N);
    const ref = Math.max(expected, SPREAD_REF_KWH);
    // Smooth spread penalty rather than a hard cutoff: a band wider than the
    // need itself still leaves a usable (if low) confidence, because the point
    // estimate is real even when day-to-day use is erratic. Halves at a band
    // width of 2x the reference need.
    const spreadScore = 1 / (1 + (high - low) / (2 * ref));
    const confidence = Math.round(100 * sizeScore * spreadScore);

    return {
      expectedKwh: round1(expected),
      lowKwh: round1(low),
      highKwh: round1(high),
      confidence,
      sampleCount: totals.length,
      weekdaySampleCount: weekdayItems.length,
      targetWeekday,
      weekdayShare: round2(alpha),
      source: 'history',
    };
  }
}

module.exports = DailyEnergyModel;
