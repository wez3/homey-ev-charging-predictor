'use strict';

/**
 * Lightweight sanity check, run with `npm test`. Not a Homey app test - it
 * fakes just enough of the Device store API for PredictionModel to run
 * standalone, and seeds a synthetic "always leaves at 07:30 on weekdays"
 * history to confirm the KDE converges on a sane prediction.
 */

const assert = require('assert');
const PredictionModel = require('../lib/PredictionModel');
const FallbackKDEModel = require('../lib/FallbackKDEModel');

class FakeDevice {
  constructor() {
    this.store = {};
  }

  getStoreValue(key) {
    return this.store[key];
  }

  async setStoreValue(key, value) {
    this.store[key] = value;
  }

  error(...args) {
    console.error(...args);
  }
}

function weekdayDate(baseMonday, weekOffset, weekday, hour, minute) {
  // weekday: 0=Sun..6=Sat, baseMonday: a Date on a Monday
  const dayOffset = (weekday + 6) % 7; // days after Monday
  const d = new Date(baseMonday);
  d.setDate(d.getDate() + weekOffset * 7 + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function run() {
  const device = new FakeDevice();
  const model = new PredictionModel(device);
  const baseMonday = new Date(2026, 0, 5); // a Monday

  // Seed 8 weeks of "always departs 07:30, arrives 18:00" on weekdays (Mon-Fri).
  for (let week = 0; week < 8; week++) {
    for (let weekday = 1; weekday <= 5; weekday++) {
      model.recordEvent('departure', weekdayDate(baseMonday, week, weekday, 7, 30));
      model.recordEvent('arrival', weekdayDate(baseMonday, week, weekday, 18, 0));
    }
  }

  const now = weekdayDate(baseMonday, 8, 3, 6, 0); // a Wednesday at 06:00, before departure
  const departure = model.predictNext('departure', now);
  const arrival = model.predictNext('arrival', now);

  console.log('Departure prediction:', departure);
  console.log('Arrival prediction:', arrival);

  assert(departure.predictedTime, 'expected a departure prediction');
  assert.strictEqual(departure.predictedTime.getHours(), 7, 'expected departure around 07:xx');
  assert(Math.abs(departure.predictedTime.getMinutes() - 30) <= 10, 'expected departure minute near :30');
  assert(departure.confidence > 50, `expected reasonably high confidence, got ${departure.confidence}`);

  assert(arrival.predictedTime, 'expected an arrival prediction');
  assert.strictEqual(arrival.predictedTime.getHours(), 18, 'expected arrival around 18:xx');

  console.log('OK: predictions converge on the seeded 07:30 / 18:00 pattern.');
}

/**
 * Cold-start confidence must reflect how *predictable* the history is, not
 * just how much of it there is. Two histories with an identical sample count
 * and identical ages - one metronomic, one scattered across five hours -
 * used to score exactly the same.
 */
function runConfidenceReflectsConsistency() {
  const targetWeekday = 3; // Wednesday

  const ages = [7, 14, 21, 28]; // four same-weekday samples, same ages in both sets
  const tight = ages.map((ageDays, i) => ({
    weekday: targetWeekday, minuteOfDay: 7 * 60 + 30 + (i % 2 ? 2 : -2), ageDays,
  }));
  const scattered = ages.map((ageDays, i) => ({
    weekday: targetWeekday, minuteOfDay: 6 * 60 + i * 75, ageDays,
  }));

  const tightResult = FallbackKDEModel.predict(tight, targetWeekday);
  const scatteredResult = FallbackKDEModel.predict(scattered, targetWeekday);

  console.log('Tight history:', tightResult, 'scattered history:', scatteredResult);

  assert(tightResult.confidence > scatteredResult.confidence + 20,
    `a consistent pattern must score clearly higher than a scattered one with the same sample count (got ${tightResult.confidence} vs ${scatteredResult.confidence})`);
  assert(tightResult.confidence > 60,
    `a metronomic pattern with a month of history should be high-confidence, got ${tightResult.confidence}`);

  // Two weeks of history is what the Insights backfill can realistically
  // supply, so that case must not be structurally pinned to a low score.
  const twoWeeks = [3.5, 10.5].map((ageDays) => ({
    weekday: targetWeekday, minuteOfDay: 7 * 60 + 30, ageDays,
  }));
  const adjacent = [2.5, 4.5, 9.5, 11.5].map((ageDays) => ({
    weekday: (targetWeekday + 1) % 7, minuteOfDay: 7 * 60 + 32, ageDays,
  }));
  const backfilled = FallbackKDEModel.predict(twoWeeks.concat(adjacent), targetWeekday);
  console.log('Two-week backfill, tight pattern:', backfilled);
  assert(backfilled.confidence > 50,
    `two weeks of a consistent pattern should clear 50%, got ${backfilled.confidence}`);

  console.log('OK: confidence tracks consistency, not just sample volume.');
}

/**
 * Leaving earlier than predicted must roll the departure forecast to the next
 * day straight away, not keep counting down to today's (already happened)
 * predicted time.
 */
function runEarlyDepartureRollsToTomorrow() {
  const device = new FakeDevice();
  const model = new PredictionModel(device);
  const baseMonday = new Date(2026, 0, 5);

  for (let week = 0; week < 4; week++) {
    for (let weekday = 1; weekday <= 5; weekday++) {
      model.recordEvent('departure', weekdayDate(baseMonday, week, weekday, 7, 30));
    }
  }

  const leftAt = weekdayDate(baseMonday, 4, 3, 7, 15); // Wednesday, 15 min early
  model.recordEvent('departure', leftAt);
  const now = new Date(leftAt.getTime() + 60000);
  const departure = model.predictNext('departure', now);

  console.log('After early departure:', departure);
  assert(departure.predictedTime, 'expected a departure prediction');
  assert.strictEqual(departure.predictedTime.getDate(), leftAt.getDate() + 1,
    `expected tomorrow's departure after leaving early, got ${departure.predictedTime}`);

  console.log('OK: an early departure rolls the forecast to the next day.');
}

/**
 * Still home after the usual departure time: the forecast must stay on today
 * when history shows later departures on this kind of day, and move on to
 * tomorrow only when nothing later is on record.
 */
function runLateDepartureStaysToday() {
  const baseMonday = new Date(2026, 0, 5);

  // Irregular Sundays: 10:00, 10:40, 11:45, 14:40 in consecutive weeks.
  const sundays = new PredictionModel(new FakeDevice());
  [[10, 0], [10, 40], [11, 45], [14, 40]].forEach(([h, m], week) => {
    sundays.recordEvent('departure', weekdayDate(baseMonday, week, 0, h, m));
  });
  const sunday = weekdayDate(baseMonday, 4, 0, 0, 0);
  const before = sundays.predictNext('departure', weekdayDate(baseMonday, 4, 0, 8, 0));
  const late = sundays.predictNext('departure', weekdayDate(baseMonday, 4, 0, 11, 0));
  console.log('Irregular Sunday, 08:00:', before, 'still home at 11:00:', late);
  assert.strictEqual(late.predictedTime.getDate(), sunday.getDate(),
    `expected a later departure today, got ${late.predictedTime}`);
  assert(late.predictedTime.getHours() >= 11, `expected after 11:00, got ${late.predictedTime}`);

  // Metronomic workdays at 07:30: nothing later on record, so a day spent at
  // home must not keep announcing an imminent departure.
  const workdays = new PredictionModel(new FakeDevice());
  for (let week = 0; week < 4; week++) {
    for (let weekday = 1; weekday <= 5; weekday++) {
      workdays.recordEvent('departure', weekdayDate(baseMonday, week, weekday, 7, 30));
    }
  }
  const wednesday = weekdayDate(baseMonday, 4, 3, 10, 0);
  const home = workdays.predictNext('departure', wednesday);
  console.log('Metronomic workday, still home at 10:00:', home);
  assert.strictEqual(home.predictedTime.getDate(), wednesday.getDate() + 1,
    `expected tomorrow when nothing later is on record, got ${home.predictedTime}`);

  console.log('OK: a late departure stays on today only when history supports it.');
}

run();
runConfidenceReflectsConsistency();
runEarlyDepartureRollsToTomorrow();
runLateDepartureStaysToday();
