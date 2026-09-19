'use strict';

/**
 * Turns a chronological list of raw event Dates (one direction: departure or
 * arrival, pooled across all weekdays) into training rows for ForestModel,
 * and builds the matching feature vector for a future prediction.
 */

const TimeSlots = require('./TimeSlots');

const NEUTRAL_GAP_DAYS = 14;
const MAX_GAP_DAYS = 21;

function cyclic(value, period) {
  const angle = (2 * Math.PI * value) / period;
  return [Math.sin(angle), Math.cos(angle)];
}

function daysSinceLastSameWeekday(priorEvents, weekday, referenceTime, timeZone) {
  for (let i = priorEvents.length - 1; i >= 0; i--) {
    if (TimeSlots.getWeekdayAndMinutes(priorEvents[i], timeZone).weekday === weekday) {
      return Math.round((referenceTime - priorEvents[i].getTime()) / 86400000);
    }
  }
  return NEUTRAL_GAP_DAYS;
}

function buildFeatureVector(targetWeekday, previousEvent, daysSincePrevSameWeekday, timeZone) {
  const [daySin, dayCos] = cyclic(targetWeekday, 7);
  const prevMinuteOfDay = TimeSlots.getWeekdayAndMinutes(previousEvent, timeZone).minuteOfDay;
  const [prevSin, prevCos] = cyclic(prevMinuteOfDay, 24 * 60);
  const gap = Math.min(daysSincePrevSameWeekday, MAX_GAP_DAYS) / MAX_GAP_DAYS;
  return [daySin, dayCos, prevSin, prevCos, gap];
}

/**
 * events: array of Date, not necessarily sorted.
 * Returns [{ features: number[], label: number(minutes since midnight) }]
 */
function buildTrainingRows(events, timeZone) {
  const sorted = [...events].sort((a, b) => a.getTime() - b.getTime());
  const rows = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const { weekday, minuteOfDay } = TimeSlots.getWeekdayAndMinutes(curr, timeZone);
    const gapDays = daysSinceLastSameWeekday(sorted.slice(0, i), weekday, curr.getTime(), timeZone);
    rows.push({
      features: buildFeatureVector(weekday, prev, gapDays, timeZone),
      label: minuteOfDay,
    });
  }
  return rows;
}

/**
 * Builds the feature vector for predicting the next occurrence of `targetWeekday`,
 * given the most recent known event (any weekday) as context.
 */
function buildPredictionFeatures(targetWeekday, lastEvent, now, timeZone) {
  if (!lastEvent) {
    return buildFeatureVector(targetWeekday, now, NEUTRAL_GAP_DAYS, timeZone);
  }
  const gapDays = Math.round((now.getTime() - lastEvent.getTime()) / 86400000);
  return buildFeatureVector(targetWeekday, lastEvent, gapDays, timeZone);
}

module.exports = { buildTrainingRows, buildPredictionFeatures };
