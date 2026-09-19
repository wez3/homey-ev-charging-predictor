'use strict';

/**
 * A Homey app process runs without TZ set, so its clock is UTC regardless of
 * the timezone configured in Homey. Everything user-facing has to be derived
 * from `this.homey.clock.getTimezone()` instead.
 *
 * Run this with TZ=UTC to reproduce the sandbox; the assertions are written so
 * they fail if anything falls back to process-local time.
 */

const assert = require('assert');
const TimeSlots = require('../lib/TimeSlots');
const PredictionModel = require('../lib/PredictionModel');

const TZ = 'Europe/Amsterdam';

class FakeDevice {
  constructor() { this.store = {}; }
  getStoreValue(k) { return this.store[k]; }
  async setStoreValue(k, v) { this.store[k] = v; }
  error(...a) { console.error(...a); }
}

function run() {
  // --- wall-clock reads happen in the given zone, not the process zone -------
  // 06:00Z in September is 08:00 in Amsterdam (CEST, +2).
  const morning = new Date('2026-09-14T06:00:00Z');
  assert.strictEqual(TimeSlots.formatTime(morning, TZ), '08:00');
  const wm = TimeSlots.getWeekdayAndMinutes(morning, TZ);
  assert.strictEqual(wm.minuteOfDay, 8 * 60, 'minute-of-day must be Amsterdam wall clock');
  assert.strictEqual(wm.weekday, 1, '2026-09-14 is a Monday');

  // --- events near midnight must not be filed against the previous day ------
  // 22:30Z Sunday is 00:30 Monday in Amsterdam.
  const justAfterMidnight = new Date('2026-09-13T22:30:00Z');
  const near = TimeSlots.getWeekdayAndMinutes(justAfterMidnight, TZ);
  assert.strictEqual(near.weekday, 1, 'must be learned as Monday, not Sunday');
  assert.strictEqual(near.minuteOfDay, 30);

  // --- constructing an instant from a wall-clock time -----------------------
  const now = new Date('2026-09-14T06:00:00Z'); // Mon 08:00 Amsterdam
  const sameDay = TimeSlots.dateOnDayOffset(now, 0, 9 * 60, TZ); // 09:00 Amsterdam
  assert.strictEqual(sameDay.toISOString(), '2026-09-14T07:00:00.000Z');
  assert.strictEqual(TimeSlots.formatTime(sameDay, TZ), '09:00');

  const nextDay = TimeSlots.dateOnDayOffset(now, 1, 7 * 60 + 30, TZ);
  assert.strictEqual(TimeSlots.formatTime(nextDay, TZ), '07:30');
  assert.strictEqual(TimeSlots.weekdayOnDayOffset(now, 1, TZ), 2, 'Tuesday');

  // --- DST: the clocks go back on 2026-10-25 in Europe/Amsterdam ------------
  // 08:00 local is +02:00 before the change and +01:00 after.
  const beforeDst = new Date('2026-10-24T06:00:00Z');
  const across = TimeSlots.dateOnDayOffset(beforeDst, 2, 8 * 60, TZ); // Mon 26 Oct
  assert.strictEqual(TimeSlots.formatTime(across, TZ), '08:00',
    'a wall-clock time must stay that wall-clock time across a DST change');
  assert.strictEqual(across.toISOString(), '2026-10-26T07:00:00.000Z',
    'and the underlying instant must shift by the new offset');

  // --- end to end: the displayed time must agree with "minutes until" -------
  // This is the reported bug: the time string came from the process clock while
  // the minutes came from a timestamp difference, so they disagreed by the UTC
  // offset.
  const model = new PredictionModel(new FakeDevice(), () => TZ);
  for (let week = 0; week < 3; week++) {
    // 08:00 Amsterdam every Monday.
    model.recordEvent('departure', new Date(Date.UTC(2026, 7, 31 + week * 7, 6, 0)));
  }

  const asOf = new Date('2026-09-20T22:00:00Z'); // Mon 00:00 Amsterdam
  const prediction = model.predictNext('departure', asOf);
  assert.ok(prediction.predictedTime, 'expected a prediction');

  const shown = TimeSlots.formatTime(prediction.predictedTime, TZ);
  const minutesUntil = Math.round((prediction.predictedTime.getTime() - asOf.getTime()) / 60000);
  assert.strictEqual(shown, '08:00', `expected 08:00 Amsterdam, got ${shown}`);

  // Independently derive the wall clock implied by the minutes counter and
  // check the two agree - that is precisely what was broken.
  const impliedFromMinutes = TimeSlots.formatTime(
    new Date(asOf.getTime() + minutesUntil * 60000), TZ,
  );
  assert.strictEqual(impliedFromMinutes, shown,
    `"${shown}" and "${minutesUntil} minutes" must describe the same moment`);
  assert.strictEqual(minutesUntil, 8 * 60, 'Mon 00:00 -> Mon 08:00 Amsterdam is 480 minutes');

  console.log(`OK: wall clock, weekday bucketing and DST all follow the Homey timezone `
    + `(predicted ${shown}, ${minutesUntil} min).`);
}

run();
