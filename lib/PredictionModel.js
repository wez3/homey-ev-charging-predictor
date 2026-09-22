'use strict';

const FallbackKDEModel = require('./FallbackKDEModel');
const ForestModel = require('./ForestModel');
const FeatureEncoder = require('./FeatureEncoder');
const TimeSlots = require('./TimeSlots');

const WINDOW_SIZE_PER_WEEKDAY = 24;
const MIN_TRAINING_EVENTS = 20;
const RETRAIN_EVERY_N_EVENTS = 3;

// Which trip of a day each direction actually cares about. A car can make
// several round-trips in a day, but a charging schedule only cares about two
// instants: the FIRST time it leaves (the "must be full by" deadline) and the
// LAST time it comes home (when it is parked for the night and available to
// charge). Learning every short midday errand instead made the model predict
// "the next trip" from a once-per-day distribution, so asking at noon "when's
// the next departure?" returned tomorrow's commute while the car actually left
// again that afternoon - errors of ~18h. All raw events are still stored; this
// reduction is applied only when training and predicting, so it is reversible
// and the raw history (and the Insights backfill) is never lost.
const DAILY_EXTREME = { departure: 'first', arrival: 'last' };

/**
 * Collapse a list of event Dates to one per calendar day (in `timeZone`):
 * the earliest of the day for 'first', the latest for 'last'. Returns the
 * kept Dates sorted chronologically.
 */
function reduceToDailyExtreme(events, timeZone, which) {
  const byDay = new Map();
  for (const d of events) {
    const p = TimeSlots.partsInZone(d, timeZone);
    const key = `${p.year}-${p.month}-${p.day}`;
    const kept = byDay.get(key);
    if (!kept) {
      byDay.set(key, d);
    } else if (which === 'first' ? d.getTime() < kept.getTime() : d.getTime() > kept.getTime()) {
      byDay.set(key, d);
    }
  }
  return [...byDay.values()].sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Predicts the next departure/arrival time for one paired device.
 * Cold start (< MIN_TRAINING_EVENTS recorded for a direction): a weighted KDE
 * over historical minute-of-day (FallbackKDEModel).
 * Trained mode (>= MIN_TRAINING_EVENTS): a small Random Forest regression
 * (ForestModel) trained on the rolling event window, retrained periodically.
 * Both models see one event per day (see DAILY_EXTREME): the first departure
 * and the last arrival, the two instants a charging schedule depends on.
 * Callers only ever use recordEvent()/predictNext() - which model is active
 * underneath is an implementation detail.
 */
class PredictionModel {
  /**
   * `getTimezone` supplies the Homey's configured IANA timezone. It must be a
   * function rather than a value because a user can change their timezone (the
   * SDK broadcasts `timezoneChange`) without the app restarting. It defaults to
   * the process timezone, which is only correct outside a Homey app sandbox -
   * device.js always passes the real one.
   */
  constructor(device, getTimezone) {
    this.device = device;
    this.getTimezone = getTimezone
      || (() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    this.forests = { departure: new ForestModel(), arrival: new ForestModel() };
    this._eventsSinceRetrain = { departure: 0, arrival: 0 };
  }

  _storeKey(direction) {
    return `${direction}Events`;
  }

  _loadEvents(direction) {
    const raw = this.device.getStoreValue(this._storeKey(direction));
    if (!raw) return Array.from({ length: 7 }, () => []);
    return raw.map((weekdayEvents) => weekdayEvents.map((iso) => new Date(iso)));
  }

  _saveEvents(direction, eventsByWeekday) {
    const serialized = eventsByWeekday.map((weekdayEvents) => weekdayEvents.map((d) => d.toISOString()));
    return this.device.setStoreValue(this._storeKey(direction), serialized);
  }

  _flatten(eventsByWeekday) {
    return eventsByWeekday.flat();
  }

  /**
   * The events the models actually learn from: one per calendar day for this
   * direction (see DAILY_EXTREME), sorted oldest-first. All raw events stay in
   * the store; this is the reduced view used for training and prediction.
   */
  _effectiveEvents(direction) {
    const all = this._flatten(this._loadEvents(direction));
    return reduceToDailyExtreme(all, this.getTimezone(), DAILY_EXTREME[direction]);
  }

  /**
   * How many distinct days are on record for a direction, for the status
   * display and the cold-start/trained threshold. Counts learned days, not raw
   * trips, because that is what the models train on.
   */
  countEvents(direction) {
    return this._effectiveEvents(direction).length;
  }

  /** Events per direction needed before the trained forest takes over. */
  static get MIN_TRAINING_EVENTS() {
    return MIN_TRAINING_EVENTS;
  }

  recordEvent(direction, date) {
    const eventsByWeekday = this._loadEvents(direction);
    const { weekday } = TimeSlots.getWeekdayAndMinutes(date, this.getTimezone());
    const list = eventsByWeekday[weekday];
    list.push(date);
    list.sort((a, b) => a.getTime() - b.getTime());
    while (list.length > WINDOW_SIZE_PER_WEEKDAY) list.shift();

    this._saveEvents(direction, eventsByWeekday).catch((err) => this.device.error(err));

    this._eventsSinceRetrain[direction] += 1;
    this._maybeRetrain(direction);
  }

  _maybeRetrain(direction) {
    const all = this._effectiveEvents(direction);
    if (all.length < MIN_TRAINING_EVENTS) return;
    if (this.forests[direction].isReady() && this._eventsSinceRetrain[direction] < RETRAIN_EVERY_N_EVENTS) return;

    const rows = FeatureEncoder.buildTrainingRows(all, this.getTimezone());
    if (rows.length >= 5) {
      this.forests[direction].train(rows);
      this._eventsSinceRetrain[direction] = 0;
    }
  }

  _toRelativeEvents(events, now) {
    const timeZone = this.getTimezone();
    return events.map((d) => {
      const { weekday, minuteOfDay } = TimeSlots.getWeekdayAndMinutes(d, timeZone);
      return {
        weekday,
        minuteOfDay,
        ageDays: Math.max(0, (now.getTime() - d.getTime()) / 86400000),
      };
    });
  }

  /**
   * Returns { predictedTime: Date|null, confidence: number,
   * source: 'forest'|'kde'|'none' }.
   */
  predictNext(direction, now) {
    const timeZone = this.getTimezone();
    const all = this._effectiveEvents(direction);

    // Recover a trained forest across app restarts once enough history exists.
    if (all.length >= MIN_TRAINING_EVENTS && !this.forests[direction].isReady()) {
      this._maybeRetrain(direction);
    }

    // Walk forward day by day and take the first *future* time. Each candidate
    // is pinned to that specific calendar day, so when today's usual time has
    // already passed the answer becomes tomorrow rather than jumping a full
    // week ahead to the next occurrence of the same weekday.
    for (let addDays = 0; addDays <= 7; addDays++) {
      const targetWeekday = TimeSlots.weekdayOnDayOffset(now, addDays, timeZone);

      if (this.forests[direction].isReady()) {
        const lastEvent = all[all.length - 1];
        const features = FeatureEncoder.buildPredictionFeatures(targetWeekday, lastEvent, now, timeZone);
        const result = this.forests[direction].predict(features);
        if (result && result.minuteOfDay != null) {
          const predictedTime = TimeSlots.dateOnDayOffset(now, addDays, Math.round(result.minuteOfDay), timeZone);
          if (predictedTime && predictedTime.getTime() > now.getTime()) {
            return { predictedTime, confidence: result.confidence, source: 'forest' };
          }
        }
      }

      const kde = FallbackKDEModel.predict(this._toRelativeEvents(all, now), targetWeekday);
      if (kde.minuteOfDay != null) {
        const predictedTime = TimeSlots.dateOnDayOffset(now, addDays, kde.minuteOfDay, timeZone);
        if (predictedTime && predictedTime.getTime() > now.getTime()) {
          return { predictedTime, confidence: kde.confidence, source: 'kde' };
        }
      }
    }

    return { predictedTime: null, confidence: 0, source: 'none' };
  }
}

module.exports = PredictionModel;
