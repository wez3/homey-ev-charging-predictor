'use strict';

/**
 * Lightweight sanity check for DailyEnergyModel + the Insights daily-reading
 * aggregation, run with `npm test`. Pure functions, timezone forced to UTC so
 * day keys are predictable.
 */

const assert = require('assert');
const DailyEnergyModel = require('../lib/DailyEnergyModel');
const { toDailyReadings, medianGapDays } = require('../lib/DailyEnergyBackfill');

const TZ = 'UTC';
const DAY = 86400000;
const key = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (base, n) => new Date(base.getTime() + n * DAY);

// Build a meterDayLog: cumulative meter starting at `startMeter`, rising by
// dailyKwh[i] on day i. Returns { log, firstDay, lastDay }.
function buildLog(startDay, startMeter, dailyKwh) {
  const log = [{ day: key(startDay), meterKwh: startMeter }];
  let meter = startMeter;
  for (let i = 0; i < dailyKwh.length; i++) {
    meter += dailyKwh[i];
    log.push({ day: key(addDays(startDay, i + 1)), meterKwh: meter });
  }
  return log;
}

function run() {
  const start = new Date('2026-01-05T00:00:00Z'); // a Monday

  // --- dailyTotals: consecutive diffs are the day's energy ---
  {
    const log = buildLog(start, 100, [8, 12, 0, 20]);
    const now = addDays(start, 5); // day after the last reading
    const totals = DailyEnergyModel.dailyTotals(log, { excludeDay: key(now) });
    assert.deepStrictEqual(totals.map((t) => t.kwh), [8, 12, 0, 20]);
  }

  // --- gaps and meter resets are dropped, not billed as one huge day ---
  {
    const log = [
      { day: '2026-02-01', meterKwh: 50 },
      { day: '2026-02-02', meterKwh: 60 }, // +10 ok
      // 2026-02-03 missing -> gap
      { day: '2026-02-04', meterKwh: 95 }, // gap from 02-02, dropped
      { day: '2026-02-05', meterKwh: 5 }, // meter reset (negative), dropped
      { day: '2026-02-06', meterKwh: 12 }, // +7 ok
    ];
    const totals = DailyEnergyModel.dailyTotals(log, { excludeDay: '2026-02-07' });
    assert.deepStrictEqual(totals.map((t) => t.kwh), [10, 7]);
  }

  // --- today's partial day is never used as a training total ---
  {
    const log = buildLog(start, 0, [10, 10, 10]);
    const today = key(addDays(start, 3)); // the last reading's day
    const totals = DailyEnergyModel.dailyTotals(log, { excludeDay: today });
    assert.strictEqual(totals.length, 2, 'the partial current day is excluded');
  }

  // --- predict: no history -> none ---
  {
    const p = DailyEnergyModel.predict([], new Date(), { timeZone: TZ });
    assert.strictEqual(p.source, 'none');
    assert.strictEqual(p.expectedKwh, null);
    assert.strictEqual(p.confidence, 0);
  }

  // --- predict: steady ~10 kWh/day -> ~10, tight band, decent confidence ---
  {
    const daily = [];
    for (let i = 0; i < 25; i++) daily.push(9 + (i % 3)); // 9,10,11
    const log = buildLog(start, 0, daily);
    const now = addDays(start, daily.length + 1);
    const p = DailyEnergyModel.predict(log, now, { timeZone: TZ });
    assert.strictEqual(p.source, 'history');
    assert.ok(p.expectedKwh >= 9 && p.expectedKwh <= 11, `~10 expected, got ${p.expectedKwh}`);
    assert.ok(p.lowKwh <= p.expectedKwh && p.expectedKwh <= p.highKwh, 'band brackets estimate');
    assert.ok(p.highKwh - p.lowKwh <= 3, 'tight band for steady history');
    assert.ok(p.confidence >= 50, `steady history fairly confident, got ${p.confidence}`);
    assert.strictEqual(p.sampleCount, 25);
  }

  // --- recency weighting: with equal-sized regimes, the recent one wins ---
  // (the median is robust by design, so a short recent burst against a long
  // history should NOT swing it - that's tested implicitly above; here the two
  // regimes are the same length, so recency weighting is what tips it.)
  {
    const daily = [];
    for (let i = 0; i < 15; i++) daily.push(5); // older half: 5 kWh/day
    for (let i = 0; i < 15; i++) daily.push(25); // recent half: 25 kWh/day
    const log = buildLog(start, 0, daily);
    const now = addDays(start, daily.length + 1);
    const p = DailyEnergyModel.predict(log, now, { timeZone: TZ });
    assert.ok(p.expectedKwh > 15, `recency should tip the tie toward the recent 25s, got ${p.expectedKwh}`);
  }

  // --- weekday conditioning: a consistently heavy weekday reads higher than
  //     a quiet one, and higher than the pooled "typical day" ---
  {
    const startMon = new Date('2026-01-05T00:00:00Z'); // Monday
    const daily = [];
    for (let i = 0; i < 42; i++) { // 6 weeks
      const wd = new Date(addDays(startMon, i + 1)).getUTCDay();
      daily.push(wd === 4 ? 30 : 3); // Thursdays 30 kWh, every other day 3
    }
    const log = buildLog(startMon, 0, daily);
    const now = addDays(startMon, daily.length + 1);
    const opts = { timeZone: TZ };

    const pooled = DailyEnergyModel.predict(log, now, opts);
    const thu = DailyEnergyModel.predict(log, now, { ...opts, targetWeekday: 4 });
    const sun = DailyEnergyModel.predict(log, now, { ...opts, targetWeekday: 0 });

    assert.ok(pooled.expectedKwh < 10, `pooled is dominated by quiet days, got ${pooled.expectedKwh}`);
    assert.ok(thu.expectedKwh > 20, `Thursday should read high, got ${thu.expectedKwh}`);
    assert.ok(sun.expectedKwh < 6, `Sunday should read low, got ${sun.expectedKwh}`);
    assert.ok(thu.weekdaySampleCount >= 5, 'saw several Thursdays');
    assert.ok(thu.weekdayShare > 0.5, `enough Thursday history to lead the blend, got ${thu.weekdayShare}`);
  }

  // --- weekday with no history falls back cleanly to the pooled estimate ---
  {
    const log = buildLog(start, 0, [10, 10, 10, 10, 10]); // Mon..Fri only
    const now = addDays(start, 6);
    const pooled = DailyEnergyModel.predict(log, now, { timeZone: TZ });
    // start is a Monday, so day+? never lands on Sunday(0) here -> no samples.
    const sun = DailyEnergyModel.predict(log, now, { timeZone: TZ, targetWeekday: 0 });
    assert.strictEqual(sun.weekdaySampleCount, 0);
    assert.strictEqual(sun.weekdayShare, 0);
    assert.strictEqual(sun.expectedKwh, pooled.expectedKwh, 'no weekday data -> pooled');
  }

  // --- backfill aggregation: last cumulative reading per day wins ---
  {
    const values = [
      { t: '2026-03-01T06:00:00Z', v: 100 },
      { t: '2026-03-01T18:00:00Z', v: 108 }, // later same day -> this wins
      { t: '2026-03-02T06:00:00Z', v: 108 },
      { t: '2026-03-02T23:00:00Z', v: 120 },
    ];
    const readings = toDailyReadings(values, TZ);
    assert.deepStrictEqual(readings, [
      { day: '2026-03-01', meterKwh: 108 },
      { day: '2026-03-02', meterKwh: 120 },
    ]);
    assert.strictEqual(medianGapDays(readings), 1);
  }

  console.log('DailyEnergyModel tests passed');
}

run();
