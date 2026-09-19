'use strict';

const FallbackKDEModel = require('./FallbackKDEModel');
const ForestModel = require('./ForestModel');
const FeatureEncoder = require('./FeatureEncoder');
const TimeSlots = require('./TimeSlots');

const WINDOW_SIZE_PER_WEEKDAY = 24;
const MIN_TRAINING_EVENTS = 20;
const RETRAIN_EVERY_N_EVENTS = 3;

/**
 * Predicts the next departure/arrival time for one paired device.
 * Cold start (< MIN_TRAINING_EVENTS recorded for a direction): a weighted KDE
 * over historical minute-of-day (FallbackKDEModel).
 * Trained mode (>= MIN_TRAINING_EVENTS): a small Random Forest regression
 * (ForestModel) trained on the rolling event window, retrained periodically.
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

  /** How many events are on record for a direction, for the status display. */
  countEvents(direction) {
    return this._flatten(this._loadEvents(direction)).length;
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
    this._maybeRetrain(direction, eventsByWeekday);
  }

  _maybeRetrain(direction, eventsByWeekday) {
    const all = this._flatten(eventsByWeekday);
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
    const eventsByWeekday = this._loadEvents(direction);
    const all = this._flatten(eventsByWeekday);

    // Recover a trained forest across app restarts once enough history exists.
    if (all.length >= MIN_TRAINING_EVENTS && !this.forests[direction].isReady()) {
      this._maybeRetrain(direction, eventsByWeekday);
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
