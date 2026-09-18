'use strict';

/**
 * Turns a chronological list of boolean samples into departure/arrival events,
 * for the Insights history backfill. (The live path can't use this - it sees
 * one value at a time as it arrives, so it debounces with a timer in device.js
 * instead. `minDwellMs` below is what keeps the two in agreement about what
 * counts as a "transition.")
 *
 * samples: [{ time: Date, present: boolean }], any order (will be sorted).
 * Returns: [{ direction: 'arrival'|'departure', time: Date }]
 *
 * The very first sample is treated as a baseline (no synthetic event for it),
 * matching the live path's "don't log an event for the first-ever observed
 * state" behavior.
 *
 * `minDwellMs` is the historical equivalent of the live path's debounce: a
 * flipped state only counts once it has held for that long. The live path gets
 * this for free (a 45s debounce timer), but the backfill used to take every
 * single flip at face value, so one noisy Insights bucket in the middle of a
 * workday produced a phantom "arrived then left again" pair - two bogus samples
 * landing in the middle of the real departure and arrival distributions. Left
 * at 0, behaviour is unchanged.
 */
function detectTransitions(samples, { minDwellMs = 0 } = {}) {
  const sorted = [...samples].sort((a, b) => a.time.getTime() - b.time.getTime());
  const events = [];
  let committed;

  for (let i = 0; i < sorted.length; i++) {
    const sample = sorted[i];
    if (committed === undefined) {
      committed = sample.present;
      continue;
    }
    if (sample.present === committed) continue;

    if (minDwellMs > 0 && !holdsFor(sorted, i, minDwellMs)) continue;

    events.push({
      direction: sample.present ? 'arrival' : 'departure',
      time: sample.time,
    });
    committed = sample.present;
  }

  return events;
}

/**
 * Does the state at sorted[start] survive for at least minDwellMs? A run that
 * reaches the end of the series counts - we can't see past the last sample, so
 * trailing state is taken at face value rather than silently dropped.
 */
function holdsFor(sorted, start, minDwellMs) {
  const state = sorted[start].present;
  const until = sorted[start].time.getTime() + minDwellMs;
  for (let i = start + 1; i < sorted.length; i++) {
    if (sorted[i].time.getTime() >= until) return true;
    if (sorted[i].present !== state) return false;
  }
  return true;
}

module.exports = { detectTransitions };
