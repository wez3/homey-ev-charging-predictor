'use strict';

/**
 * Turns a chronological list of raw event Dates (one direction: departure or
 * arrival, pooled across all weekdays) into training rows for ForestModel,
 * and builds the matching feature vector for a future prediction.
 */

const NEUTRAL_GAP_DAYS = 14;
const MAX_GAP_DAYS = 21;

function cyclic(value, period) {
  const angle = (2 * Math.PI * value) / period;
  return [Math.sin(angle), Math.cos(angle)];
}

function daysSinceLastSameWeekday(priorEvents, weekday, referenceTime) {
  for (let i = priorEvents.length - 1; i >= 0; i--) {
    if (priorEvents[i].getDay() === weekday) {
      return Math.round((referenceTime - priorEvents[i].getTime()) / 86400000);
    }
  }
  return NEUTRAL_GAP_DAYS;
}

function buildFeatureVector(targetWeekday, previousEvent, daysSincePrevSameWeekday) {
  const [daySin, dayCos] = cyclic(targetWeekday, 7);
  const prevMinuteOfDay = previousEvent.getHours() * 60 + previousEvent.getMinutes();
  const [prevSin, prevCos] = cyclic(prevMinuteOfDay, 24 * 60);
  const gap = Math.min(daysSincePrevSameWeekday, MAX_GAP_DAYS) / MAX_GAP_DAYS;
  return [daySin, dayCos, prevSin, prevCos, gap];
}

/**
 * events: array of Date, not necessarily sorted.
 * Returns [{ features: number[], label: number(minutes since midnight) }]
 */
function buildTrainingRows(events) {
  const sorted = [...events].sort((a, b) => a.getTime() - b.getTime());
  const rows = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gapDays = daysSinceLastSameWeekday(sorted.slice(0, i), curr.getDay(), curr.getTime());
    rows.push({
      features: buildFeatureVector(curr.getDay(), prev, gapDays),
      label: curr.getHours() * 60 + curr.getMinutes(),
    });
  }
  return rows;
}

/**
 * Builds the feature vector for predicting the next occurrence of `targetWeekday`,
 * given the most recent known event (any weekday) as context.
 */
function buildPredictionFeatures(targetWeekday, lastEvent, now) {
  if (!lastEvent) {
    return buildFeatureVector(targetWeekday, now, NEUTRAL_GAP_DAYS);
  }
  const gapDays = Math.round((now.getTime() - lastEvent.getTime()) / 86400000);
  return buildFeatureVector(targetWeekday, lastEvent, gapDays);
}

module.exports = { buildTrainingRows, buildPredictionFeatures };
