'use strict';

/**
 * Prediction: a per-weekday weighted kernel density estimate (KDE)
 * over minute-of-day.
 * Pure statistics, no training step - works from the very first event.
 */

const HALF_LIFE_DAYS = 42; // ~6 weeks: how fast older events fade
const ADJACENT_WEEKDAY_WEIGHT = 0.35; // borrow some signal from neighboring weekdays

// Two weeks of backfilled history is exactly one observation per weekday, so
// a weekday has almost nothing of its own to go on. Commutes are shaped more
// by "workday vs weekend" than by which workday it is, so a day also borrows
// weakly from the other days of its own type. Deliberately well below
// ADJACENT_WEEKDAY_WEIGHT: at 0.35 this starts overriding a day's own
// observation (verified against real data - a genuine Tuesday 11:00 departure
// got dragged to the Mon/Wed/Thu 06:00 cluster), at 0.2 it only reinforces
// days that already agree.
const SAME_DAY_TYPE_WEIGHT = 0.2;
const BANDWIDTH_MINUTES = 25;

// Confidence is the product of two terms: how much history we have, and how
// tightly that history clusters around the predicted time.
//
// Volume alone used to be the whole score, which pinned it structurally low:
// samples are bucketed per weekday, so two weeks of history gives a given
// weekday ~3 weighted samples. Requiring 8 meant ~8 weeks of history for a
// full score, while the Insights backfill can only ever supply 2 weeks - so a
// metronomically regular commute still reported ~35%.
const SAMPLE_WEIGHT_FOR_FULL_CONFIDENCE = 4;

// ...and volume alone said nothing about whether the pattern is actually
// predictable: leaving at 08:00 +/- 3 min every day scored the same as leaving
// anywhere between 06:00 and 11:00. That makes a Flow condition like
// "confidence > 60%" meaningless, which is the capability's whole purpose.
// Spread is measured only over the samples near the predicted mode, so one
// odd day out doesn't drag down an otherwise reliable pattern.
const CLUSTER_RADIUS_MINUTES = 90;
const TIGHT_SPREAD_MINUTES = 10; // at or below this: full marks
const LOOSE_SPREAD_MINUTES = 80; // at or above this: floor
const LOOSE_SPREAD_SCORE = 0.25;

function gaussianKernel(deltaMinutes, bandwidth) {
  return Math.exp(-0.5 * (deltaMinutes / bandwidth) ** 2);
}

function recencyWeight(ageDays) {
  return 2 ** (-ageDays / HALF_LIFE_DAYS);
}

function weekdayDistance(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 7 - diff);
}

function isWorkday(weekday) {
  return weekday >= 1 && weekday <= 5;
}

/**
 * How concentrated the history is around the predicted minute, as a 0-1
 * multiplier. Two things matter and both are needed:
 *  - what share of the total weight falls near the prediction at all (a
 *    history split across three different departure times should not look
 *    confident just because one of the three clusters is tight), and
 *  - how tightly that near cluster sits (07:30 +/- 2 min beats +/- 50 min).
 * Measuring spread only within the cluster is deliberate: one odd day out
 * shouldn't drag down an otherwise reliable pattern, it should just cost a
 * little share.
 */
function concentrationScore(samples, aroundMinute) {
  let totalWeight = 0;
  let clusterWeight = 0;
  let deviationSum = 0;

  for (const s of samples) {
    totalWeight += s.weight;
    const delta = Math.abs(s.minuteOfDay - aroundMinute);
    if (delta > CLUSTER_RADIUS_MINUTES) continue;
    clusterWeight += s.weight;
    deviationSum += s.weight * delta;
  }

  if (totalWeight === 0 || clusterWeight === 0) return LOOSE_SPREAD_SCORE;

  const share = clusterWeight / totalWeight;
  const spreadMinutes = deviationSum / clusterWeight;

  let tightness;
  if (spreadMinutes <= TIGHT_SPREAD_MINUTES) tightness = 1;
  else if (spreadMinutes >= LOOSE_SPREAD_MINUTES) tightness = LOOSE_SPREAD_SCORE;
  else {
    const t = (spreadMinutes - TIGHT_SPREAD_MINUTES) / (LOOSE_SPREAD_MINUTES - TIGHT_SPREAD_MINUTES);
    tightness = 1 - t * (1 - LOOSE_SPREAD_SCORE);
  }

  return share * tightness;
}

/**
 * events: array of { weekday: 0-6, minuteOfDay: number, ageDays: number }
 */
function collectWeightedSamples(events, targetWeekday) {
  const samples = [];
  for (const ev of events) {
    const distance = weekdayDistance(ev.weekday, targetWeekday);
    let weekdayWeight;
    if (distance === 0) weekdayWeight = 1;
    else if (distance === 1) weekdayWeight = ADJACENT_WEEKDAY_WEIGHT;
    else if (isWorkday(ev.weekday) === isWorkday(targetWeekday)) weekdayWeight = SAME_DAY_TYPE_WEIGHT;
    else continue;

    const weight = weekdayWeight * recencyWeight(ev.ageDays);
    if (weight > 0.01) samples.push({ minuteOfDay: ev.minuteOfDay, weight });
  }
  return samples;
}

/**
 * Returns { minuteOfDay, confidence }. minuteOfDay is null when there is no
 * usable history for this weekday yet.
 */
function predict(events, targetWeekday) {
  const samples = collectWeightedSamples(events, targetWeekday);
  const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0);

  if (totalWeight === 0) return { minuteOfDay: null, confidence: 0 };

  let bestMinute = null;
  let bestDensity = -Infinity;
  for (let minute = 0; minute < 24 * 60; minute += 5) {
    let density = 0;
    for (const s of samples) {
      density += s.weight * gaussianKernel(minute - s.minuteOfDay, BANDWIDTH_MINUTES);
    }
    if (density > bestDensity) {
      bestDensity = density;
      bestMinute = minute;
    }
  }

  const volumeScore = Math.min(1, totalWeight / SAMPLE_WEIGHT_FOR_FULL_CONFIDENCE);
  const confidence = Math.max(0, Math.min(100, Math.round(volumeScore * concentrationScore(samples, bestMinute) * 100)));

  return { minuteOfDay: bestMinute, confidence };
}

module.exports = { predict };
