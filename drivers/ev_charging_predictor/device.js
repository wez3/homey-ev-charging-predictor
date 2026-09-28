'use strict';

const Homey = require('homey');
const PredictionModel = require('../../lib/PredictionModel');
const TimeSlots = require('../../lib/TimeSlots');
const InsightsBackfill = require('../../lib/InsightsBackfill');
const ChargerConventions = require('../../lib/ChargerConventions');
const DailyEnergyModel = require('../../lib/DailyEnergyModel');
const DailyEnergyBackfill = require('../../lib/DailyEnergyBackfill');

const DEFAULT_DEBOUNCE_SECONDS = 45;
const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;
const RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PREDICTION_CHANGE_THRESHOLD_MS = 5 * 60 * 1000;
// Bumping this re-runs the one-time history reset + Insights backfill, which is
// how an already-installed device picks up a better backfill source.
const EVENT_SCHEMA_VERSION = 4;

// We keep a log of the charger's own cumulative energy meter (kWh), one
// reading per calendar day (the latest of that day winning), in its own store
// key `meterDayLog`. DailyEnergyModel turns consecutive days' readings into
// per-day energy totals to predict a typical day's charge need. Charger-only -
// no car/SoC dependency - and independent of the departure/arrival event store
// and its schema version, so it can't affect the time models.
const METER_CAPABILITY_ID = 'meter_power';
const METER_DAY_LOG_MAX = 400; // > a year of daily readings; bounds store size

class EVChargingPredictorDevice extends Homey.Device {

  async onInit() {
    this.model = new PredictionModel(this, () => this.homey.clock.getTimezone());
    this._committedPresence = undefined;
    this._debounceTimer = null;
    this._pendingPresence = undefined;
    this._guardInstances = [];
    this._currentInstances = [];
    this._lastPrediction = null;
    this._lastChargeNeed = null;

    // Departure-accuracy logging: the forecast we are currently "betting" on
    // for the next departure, and the last day we already posted a score for
    // (so we grade only the first departure of each day - the one the model
    // actually targets). Both persist so a restart doesn't lose or double-log.
    this._outstandingDeparture = this.getStoreValue('outstandingDeparture') || null;
    this._lastAccuracyLogDay = this.getStoreValue('lastAccuracyLogDay') || null;

    // Devices paired before these capabilities existed don't get them automatically.
    if (!this.hasCapability('prediction_status')) {
      await this.addCapability('prediction_status').catch(this.error);
    }
    if (!this.hasCapability('predicted_charge_kwh')) {
      await this.addCapability('predicted_charge_kwh').catch(this.error);
    }

    await this.homey.app.apiReadyPromise;
    await this._clearHistoryPollutedByFixedBugs();
    await this._bindSource();
    await this._maybeBackfillFromInsights();
    await this._maybeBackfillDailyEnergy();
    await this._upsertMeterDay(new Date());

    this._recomputeInterval = this.homey.setInterval(async () => {
      await this._pollCurrentState();
      await this.recomputePredictions();
    }, RECOMPUTE_INTERVAL_MS);
    this._resyncInterval = this.homey.setInterval(() => this._bindSource(), RESYNC_INTERVAL_MS);

    await this.recomputePredictions();
  }

  // Events recorded before the presence-detection fixes are untrustworthy: a
  // flicker bug committed bogus departures at arbitrary times, and presence
  // could latch "away" so arrivals were never recorded at all. Training on
  // that history would keep producing bad predictions forever, so it is wiped
  // once when upgrading past it.
  async _clearHistoryPollutedByFixedBugs() {
    if (this.getStoreValue('eventSchemaVersion') === EVENT_SCHEMA_VERSION) return;

    await this.setStoreValue('departureEvents', null).catch(this.error);
    await this.setStoreValue('arrivalEvents', null).catch(this.error);
    await this.setStoreValue('historyBackfilled', false).catch(this.error);
    await this.setStoreValue('eventSchemaVersion', EVENT_SCHEMA_VERSION).catch(this.error);
    this.log('Cleared recorded history polluted by the presence-detection bugs fixed in this version; relearning from scratch.');
  }

  // One-time, best-effort: seed history from Homey's own Insights log for the
  // bound capability, if one exists, instead of starting from zero. Safe to
  // call on every restart - it no-ops once `historyBackfilled` is set, and
  // no-ops immediately if Insights simply has no data for this capability
  // (common: Insights logging is opt-in per capability and often isn't on).
  async _maybeBackfillFromInsights() {
    if (this.getStoreValue('historyBackfilled')) return;

    const settings = this.getSettings();
    try {
      let events = await InsightsBackfill.backfillEvents(this.homey.app.api, {
        deviceId: settings.homeyDeviceId,
        capabilityId: settings.stateCapabilityId,
        awayValues: ChargerConventions.resolveAwayValues(settings),
      });
      let via = settings.stateCapabilityId;

      // The bound state capability is an enum, and Homey Insights only logs
      // numbers/booleans - so the above essentially always comes back empty.
      // The charger's per-phase current does carry the plug history though.
      if (events.length === 0) {
        const numeric = await InsightsBackfill.backfillFromNumericSource(this.homey.app.api, {
          deviceId: settings.homeyDeviceId,
          sources: ChargerConventions.plugStateSourcesFor(this.sourceDevice),
        });
        events = numeric.events;
        via = numeric.capabilityId
          ? `${numeric.capabilityId} over ${numeric.spanDays}d (${numeric.windows.join('+')})`
          : via;
      }

      for (const event of events) {
        this.model.recordEvent(event.direction, event.time);
      }

      if (events.length > 0) {
        this.log(`Backfilled ${events.length} departure/arrival events from Insights history via ${via}.`);
      }
    } catch (err) {
      this.error('Insights backfill failed, continuing without it:', err.message);
    } finally {
      // Only ever attempt this once per device, whether it found data or not.
      await this.setStoreValue('historyBackfilled', true).catch(this.error);
    }
  }

  async _bindSource() {
    const settings = this.getSettings();
    this._destroyCapabilityInstances();

    try {
      const api = this.homey.app.api;
      this.sourceDevice = await api.devices.getDevice({ id: settings.homeyDeviceId, $cache: false });

      // makeCapabilityInstance only pushes future changes - without this, a
      // freshly (re)paired device shows no car_present value at all until the
      // charger's state next changes, even though the charger already has one.
      await this._applyInitialState(settings);

      this._stateInstance = this.sourceDevice.makeCapabilityInstance(
        settings.stateCapabilityId,
        () => this._reevaluateFromDevice(),
      );

      // Also watch the guard capability (e.g. Easee's charger_status). The two
      // don't necessarily update in the same event: if charger_status flips to
      // "Completed" just after evcharger_charging_state flipped to
      // "plugged_out", only watching the latter would leave presence wrong
      // until its next change - which may never come while parked.
      for (const guardId of ChargerConventions.guardCapabilityIdsFor(this.sourceDevice)) {
        this._guardInstances.push(this.sourceDevice.makeCapabilityInstance(
          guardId,
          () => this._reevaluateFromDevice(),
        ));
      }

      // And the per-phase current, for the same reason - more so, in fact.
      // _resolvePresence only believes "away" when no other signal contradicts
      // it, and a current reading left over from when the cable was connected
      // contradicts it. Without subscribing, that reading only refreshed on the
      // 5-minute poll, so unplugging the car sat unnoticed for minutes: the
      // state capability pushed "plugged_out" instantly and the stale current
      // vetoed it. The veto is one-directional, so this could only ever delay
      // departures, never arrivals - which is exactly how it presented.
      for (const capId of ChargerConventions.numericSourceIdsFor(this.sourceDevice)) {
        this._currentInstances.push(this.sourceDevice.makeCapabilityInstance(
          capId,
          () => this._reevaluateFromDevice(),
        ));
      }

      await this.setAvailable().catch(() => {});
    } catch (err) {
      this.error('Failed to bind charger, will retry:', err.message);
      await this.setUnavailable('Bound charger is unavailable').catch(() => {});
    }
  }

  async _applyInitialState(settings) {
    if (this._committedPresence !== undefined) return; // already tracking live; don't overwrite from a resync read
    const present = this._currentPresence(settings);
    if (present === undefined) return;

    this._committedPresence = present;
    await this.setCapabilityValue('car_present', present).catch(this.error);
  }

  _destroyCapabilityInstances() {
    if (this._stateInstance) { this._stateInstance.destroy(); this._stateInstance = null; }
    for (const instance of this._guardInstances) instance.destroy();
    this._guardInstances = [];
    for (const instance of this._currentInstances) instance.destroy();
    this._currentInstances = [];
  }

  // A charger's own "away" reading isn't trustworthy on its own: some apps'
  // internal state machines conflate "charging session completed, cable still
  // connected" with "actually unplugged" - a confirmed real bug (see
  // ChargerConventions.js). So "away" is only believed when NO other signal on
  // the same charger contradicts it. Two can:
  //   - the raw, non-collapsed session status (a vendor string), and
  //   - the per-phase current, which is physical evidence rather than a state
  //     machine, and is also what the Insights backfill reads, so live
  //     detection and learned history agree on what "plugged in" means.
  // Any positive evidence of a connected cable wins; a departure needs all of
  // them to agree. A charger exposing neither simply falls back to the enum.
  _resolvePresence(rawValue, settings) {
    const isAway = ChargerConventions.resolveAwayValues(settings).includes(rawValue);
    if (!isAway) return true;

    if (ChargerConventions.looksConnectedByCurrent(this.sourceDevice)) return true;
    if (ChargerConventions.looksLikeCompletedSessionStillConnected(this.sourceDevice)) return true;
    return false;
  }

  // Derives presence from the charger's CURRENT values rather than from a
  // single pushed value, so the state capability and the guard capability are
  // always read together and consistently.
  _currentPresence(settings) {
    const capsObj = this.sourceDevice && this.sourceDevice.capabilitiesObj;
    const stateCap = capsObj && capsObj[settings.stateCapabilityId];
    if (!stateCap || stateCap.value === undefined || stateCap.value === null) return undefined;
    return this._resolvePresence(stateCap.value, settings);
  }

  _reevaluateFromDevice() {
    this._evaluatePresence(this._currentPresence(this.getSettings()));
  }

  // Re-reads the charger from the API and re-evaluates. Everything else here
  // is push-driven, so a single missed/out-of-order update would otherwise
  // leave presence permanently stuck (exactly how car_present could latch to
  // "no" and never return). This is the self-healing safety net.
  async _pollCurrentState() {
    const settings = this.getSettings();
    try {
      const api = this.homey.app.api;
      this.sourceDevice = await api.devices.getDevice({ id: settings.homeyDeviceId, $cache: false });
      this._evaluatePresence(this._currentPresence(settings));
    } catch (err) {
      this.error('Charger poll failed:', err.message);
    }
  }

  _evaluatePresence(present) {
    if (present === undefined) return;

    // A reading that agrees with the committed state cancels any pending flip.
    // Without this, a brief flicker to "away" and straight back to "present"
    // would still commit the stale "away" when its debounce elapsed - which
    // both recorded a bogus departure and latched presence to the wrong value
    // with no further event coming to correct it.
    if (present === this._committedPresence) {
      this._cancelPendingCommit();
      return;
    }

    // A repeat of a flip that is already counting down must NOT restart the
    // countdown. Several capabilities feed this now (state, guard status and
    // each phase current), and current updates can arrive every few seconds -
    // restarting the timer on every one of them would hold the commit off
    // indefinitely and latch presence at the old value for as long as the
    // charger keeps talking.
    if (this._debounceTimer && this._pendingPresence === present) return;

    this._cancelPendingCommit();

    const settings = this.getSettings();
    const debounceMs = (settings.debounceSeconds != null ? settings.debounceSeconds : DEFAULT_DEBOUNCE_SECONDS) * 1000;
    this._pendingPresence = present;
    this._debounceTimer = this.homey.setTimeout(() => this._commitPresence(present), debounceMs);
  }

  _cancelPendingCommit() {
    if (this._debounceTimer) {
      this.homey.clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingPresence = undefined;
  }

  async _commitPresence(present) {
    this._debounceTimer = null;
    this._pendingPresence = undefined;
    if (present === this._committedPresence) return;

    const wasKnown = this._committedPresence !== undefined;
    this._committedPresence = present;
    await this.setCapabilityValue('car_present', present).catch(this.error);

    // Don't log a synthetic event for the first-ever observed state - only real transitions.
    if (!wasKnown) return;

    const direction = present ? 'arrival' : 'departure';
    const now = new Date();

    // Grade the forecast against reality before recording the event (which,
    // via the recompute below, replaces the outstanding forecast with the next
    // day's). Only the first departure of the day is scored.
    if (direction === 'departure') {
      await this._maybeLogDepartureAccuracy(now);
    }

    this.model.recordEvent(direction, now);
    this.log(`Committed ${direction} event at ${now.toISOString()}`);

    await this.recomputePredictions();
  }

  // One-time, best-effort: seed the daily-energy history from Homey Insights'
  // record of the charger's cumulative meter, so the kWh prediction starts with
  // real per-day totals instead of a single reading. No-ops once done, and
  // no-ops harmlessly if Insights has no usable meter history. Merges under any
  // days already logged live, so re-running never overwrites fresher readings.
  async _maybeBackfillDailyEnergy() {
    if (this.getStoreValue('dailyEnergyBackfilled')) return;

    const settings = this.getSettings();
    try {
      const { readings, resolution, days } = await DailyEnergyBackfill.backfillDailyReadings(
        this.homey.app.api,
        { deviceId: settings.homeyDeviceId, timeZone: this.homey.clock.getTimezone() },
      );
      if (readings.length > 0) {
        await this._mergeMeterDays(readings);
        this.log(`Backfilled ${days} daily meter readings from Insights (${resolution}).`);
      }
    } catch (err) {
      this.error('Daily-energy backfill failed, continuing without it:', err.message);
    } finally {
      await this.setStoreValue('dailyEnergyBackfilled', true).catch(this.error);
    }
  }

  // Records the current cumulative meter as today's reading (latest of the day
  // wins), so a completed day holds its end-of-day total. Called on every
  // recompute and at init - cheap and idempotent. No meter capability, or no
  // reading yet, means there's simply nothing to record.
  async _upsertMeterDay(when) {
    const meterKwh = this._readMeterKwh();
    if (typeof meterKwh !== 'number') return;
    const day = TimeSlots.dayKey(when, this.homey.clock.getTimezone());
    await this._mergeMeterDays([{ day, meterKwh }]);
  }

  // Merge readings into the stored per-day log, keeping one entry per day (the
  // incoming value wins on a collision, as it's the fresher reading), sorted
  // oldest-first and bounded in size. Self-contained: reads, merges and persists
  // in one awaited step so concurrent callers don't clobber each other.
  async _mergeMeterDays(readings) {
    const byDay = new Map();
    for (const e of this.getStoreValue('meterDayLog') || []) byDay.set(e.day, e.meterKwh);
    for (const e of readings) byDay.set(e.day, e.meterKwh);
    let merged = [...byDay.entries()]
      .map(([day, meterKwh]) => ({ day, meterKwh }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    if (merged.length > METER_DAY_LOG_MAX) merged = merged.slice(merged.length - METER_DAY_LOG_MAX);
    await this.setStoreValue('meterDayLog', merged);
  }

  _readMeterKwh() {
    const caps = this.sourceDevice && this.sourceDevice.capabilitiesObj;
    const cap = caps && caps[METER_CAPABILITY_ID];
    return cap && typeof cap.value === 'number' ? cap.value : null;
  }

  async recomputePredictions() {
    const now = new Date();
    await this._upsertMeterDay(now);
    const departure = this.model.predictNext('departure', now);
    const arrival = this.model.predictNext('arrival', now);

    this._trackDepartureOutstanding(departure, now);

    await this._applyPrediction('departure', departure, now);
    await this._applyPrediction('arrival', arrival, now);
    await this._applyChargeNeed(now);
    await this._applyStatus(departure, arrival);

    if (this._hasChangedMaterially(departure, arrival)) {
      const tz = this.homey.clock.getTimezone();
      this._lastPrediction = { departure, arrival };
      this.homey.flow.getDeviceTriggerCard('prediction_updated').trigger(this, {
        departureTime: departure.predictedTime ? TimeSlots.formatTime(departure.predictedTime, tz) : '',
        departureConfidence: departure.confidence,
        arrivalTime: arrival.predictedTime ? TimeSlots.formatTime(arrival.predictedTime, tz) : '',
        arrivalConfidence: arrival.confidence,
      }, {}).catch(this.error);
    }

    await this._maybeFireWithinTrigger('departure', departure, now);
    await this._maybeFireWithinTrigger('arrival', arrival, now);
  }

  _dayKey(date) {
    const p = TimeSlots.partsInZone(date, this.homey.clock.getTimezone());
    return `${p.year}-${p.month}-${p.day}`;
  }

  // Remembers the departure forecast to grade later. It keeps refreshing while
  // the forecast is for *today's* departure (so we grade the final morning
  // forecast, not a stale one), and seeds itself from a forecast for a future
  // day when nothing is held yet. Crucially it does NOT overwrite a same-day
  // forecast once "now" has passed the predicted time: predictNext then
  // re-forecasts later today or rolls to tomorrow, and grading against either
  // would hide the real miss. All persisted so a restart mid-morning still
  // grades correctly.
  _trackDepartureOutstanding(prediction, now) {
    if (!prediction || !prediction.predictedTime) return;
    const predDay = this._dayKey(prediction.predictedTime);
    const nowDay = this._dayKey(now);
    if (predDay !== nowDay && this._outstandingDeparture) return;

    const held = this._outstandingDeparture;
    if (held && this._dayKey(new Date(held.predictedTime)) === nowDay
      && new Date(held.predictedTime).getTime() <= now.getTime()) return;

    this._outstandingDeparture = {
      predictedTime: prediction.predictedTime.toISOString(),
      confidence: prediction.confidence,
      predictedAt: now.toISOString(),
    };
    this.setStoreValue('outstandingDeparture', this._outstandingDeparture).catch(this.error);
  }

  // On the first departure of the day, post to the timeline how far the
  // standing forecast was off. Only grades a forecast that was actually about
  // today, and only once per day.
  async _maybeLogDepartureAccuracy(actualDate) {
    const today = this._dayKey(actualDate);
    if (this._lastAccuracyLogDay === today) return;

    const outstanding = this._outstandingDeparture;
    if (!outstanding || !outstanding.predictedTime) return;

    const predicted = new Date(outstanding.predictedTime);
    if (this._dayKey(predicted) !== today) return;

    const tz = this.homey.clock.getTimezone();
    const errMin = Math.round((predicted.getTime() - actualDate.getTime()) / 60000);
    const abs = Math.abs(errMin);
    // Phrased from the driver's side ("left ... than predicted"): "30 min too
    // late" was ambiguous and read as the car leaving late when it had in fact
    // left 30 min before the forecast.
    const verdict = errMin === 0
      ? 'spot on'
      : `left ${abs} min ${errMin > 0 ? 'earlier' : 'later'} than predicted`;
    const excerpt = `🚗 Departure prediction: predicted ${TimeSlots.formatTime(predicted, tz)}, `
      + `actual ${TimeSlots.formatTime(actualDate, tz)} — ${verdict} `
      + `(confidence ${outstanding.confidence}%)`;

    await this._writeTimeline(excerpt);

    this._lastAccuracyLogDay = today;
    await this.setStoreValue('lastAccuracyLogDay', today).catch(this.error);
    this._outstandingDeparture = null;
    await this.setStoreValue('outstandingDeparture', null).catch(this.error);
  }

  async _writeTimeline(excerpt) {
    try {
      await this.homey.notifications.createNotification({ excerpt });
      this.log('Timeline:', excerpt);
    } catch (err) {
      this.error('Could not write to timeline:', err.message);
    }
  }

  // Without this, a device that has no history yet shows nothing but blank
  // fields, and the user cannot tell "still learning" from "broken". That is
  // the normal first experience for any charger without an Insights backfill
  // source - which, outside Easee, is most of them - so it needs to say so.
  async _applyStatus(departure, arrival) {
    const departures = this.model.countEvents('departure');
    const arrivals = this.model.countEvents('arrival');
    const days = Math.max(departures, arrivals);
    const recorded = `${days} day${days === 1 ? '' : 's'}`;

    let status;
    if (departures + arrivals === 0) {
      status = 'Learning - no trips recorded yet';
    } else if (!departure.predictedTime && !arrival.predictedTime) {
      status = `Learning - ${recorded} recorded`;
    } else {
      status = `Predicting from ${recorded}`;
    }

    await this.setCapabilityValue('prediction_status', status).catch(this.error);
  }

  _hasChangedMaterially(departure, arrival) {
    if (!this._lastPrediction) return true;
    const changed = (prev, next) => {
      if (!prev.predictedTime || !next.predictedTime) return prev.predictedTime !== next.predictedTime;
      return Math.abs(prev.predictedTime.getTime() - next.predictedTime.getTime()) > PREDICTION_CHANGE_THRESHOLD_MS;
    };
    return changed(this._lastPrediction.departure, departure) || changed(this._lastPrediction.arrival, arrival);
  }

  async _applyPrediction(direction, prediction, now) {
    const prefix = `predicted_${direction}`;
    const minutesUntil = prediction.predictedTime
      ? Math.round((prediction.predictedTime.getTime() - now.getTime()) / 60000)
      : null;

    await this.setCapabilityValue(`${prefix}_time`, prediction.predictedTime ? TimeSlots.formatTime(prediction.predictedTime, this.homey.clock.getTimezone()) : '').catch(this.error);
    await this.setCapabilityValue(`${prefix}_minutes`, minutesUntil).catch(this.error);
    await this.setCapabilityValue(`${prefix}_confidence`, prediction.predictedTime ? prediction.confidence : null).catch(this.error);
  }

  // Predicts the coming day's energy need from the per-day meter log,
  // conditioned on that day's weekday so weekly patterns show, publishes the
  // point estimate on its capability, and fires the Flow trigger (with a
  // low/high band) when it moves enough to matter. Null when there's no usable
  // daily history yet. Targets tomorrow - the day tonight's charging is planned
  // for.
  async _applyChargeNeed(now) {
    const timeZone = this.homey.clock.getTimezone();
    const chargeNeed = DailyEnergyModel.predict(
      this.getStoreValue('meterDayLog') || [],
      now,
      { timeZone, targetWeekday: TimeSlots.weekdayOnDayOffset(now, 1, timeZone) },
    );

    await this.setCapabilityValue(
      'predicted_charge_kwh',
      chargeNeed.source === 'none' ? null : chargeNeed.expectedKwh,
    ).catch(this.error);

    if (this._chargeNeedChangedMaterially(chargeNeed)) {
      this._lastChargeNeed = chargeNeed;
      this.homey.flow.getDeviceTriggerCard('charge_need_updated').trigger(this, {
        expectedKwh: chargeNeed.expectedKwh,
        lowKwh: chargeNeed.lowKwh,
        highKwh: chargeNeed.highKwh,
        confidence: chargeNeed.confidence,
      }, {}).catch(this.error);
    }

    await this._gradeAndTrackChargeNeed(now, chargeNeed);
  }

  // Remembers the forecast we're showing for tomorrow, then, once a forecast's
  // day has completed and its actual energy is known, posts to the timeline how
  // close it was - the kWh counterpart of the departure-accuracy note. Forecasts
  // are kept per day in a small store list so the day we're waiting to grade and
  // the next day we're already forecasting don't overwrite each other; graded
  // entries are removed so each day is posted once, surviving restarts.
  async _gradeAndTrackChargeNeed(now, chargeNeed) {
    const tz = this.homey.clock.getTimezone();
    const today = TimeSlots.dayKey(now, tz);
    let forecasts = this.getStoreValue('chargeNeedForecasts') || [];

    // Track: refresh the standing forecast for tomorrow (skip when we have no
    // real estimate to grade against).
    if (chargeNeed.source === 'history') {
      const tomorrow = TimeSlots.dayKeyOnDayOffset(now, 1, tz);
      forecasts = forecasts.filter((f) => f.day !== tomorrow);
      forecasts.push({
        day: tomorrow,
        expectedKwh: chargeNeed.expectedKwh,
        lowKwh: chargeNeed.lowKwh,
        highKwh: chargeNeed.highKwh,
        confidence: chargeNeed.confidence,
      });
    }

    // Grade: for any forecast whose day has completed and now has an actual
    // daily total. A completed day with no actual yet (a data gap) is kept a
    // few days, then dropped rather than graded against nothing.
    const actuals = new Map(
      DailyEnergyModel.dailyTotals(this.getStoreValue('meterDayLog') || [], { excludeDay: today })
        .map((t) => [t.day, t.kwh]),
    );
    const remaining = [];
    for (const f of forecasts) {
      if (f.day >= today) { remaining.push(f); continue; } // today or future - not done
      const actual = actuals.get(f.day);
      if (actual == null) {
        if (TimeSlots.dayKeyDiff(f.day, today) <= 3) remaining.push(f);
        continue;
      }
      await this._writeChargeNeedAccuracy(f, actual, tz);
    }

    await this.setStoreValue('chargeNeedForecasts', remaining).catch(this.error);
  }

  async _writeChargeNeedAccuracy(forecast, actualKwh, tz) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weekday = dayNames[TimeSlots.weekdayOfDayKey(forecast.day)];
    const actual = Math.round(actualKwh * 10) / 10;
    const inBand = actualKwh >= forecast.lowKwh && actualKwh <= forecast.highKwh;
    const bandVerdict = inBand ? 'within the expected band'
      : (actualKwh > forecast.highKwh ? 'above the band' : 'below the band');
    const diff = Math.round((actual - forecast.expectedKwh) * 10) / 10;
    const diffVerdict = diff === 0 ? 'spot on'
      : `${Math.abs(diff)} kWh ${diff > 0 ? 'more' : 'less'} than predicted`;

    const excerpt = `🔋 Charge need ${weekday}: predicted ${forecast.expectedKwh} kWh `
      + `(band ${forecast.lowKwh}–${forecast.highKwh}), actual ${actual} kWh — `
      + `${bandVerdict}, ${diffVerdict} (confidence ${forecast.confidence}%)`;

    await this._writeTimeline(excerpt);
  }

  // Fire only on a real move: the first usable estimate, or a shift of at least
  // 0.5 kWh in the expected need. A 'none' result (no history) never fires and
  // never overwrites the last real value we told Flows about.
  _chargeNeedChangedMaterially(next) {
    if (next.source === 'none') return false;
    if (!this._lastChargeNeed || this._lastChargeNeed.source === 'none') return true;
    return Math.abs(this._lastChargeNeed.expectedKwh - next.expectedKwh) >= 0.5;
  }

  async _maybeFireWithinTrigger(direction, prediction, now) {
    if (!prediction.predictedTime) return;
    const minutesUntil = Math.round((prediction.predictedTime.getTime() - now.getTime()) / 60000);
    if (minutesUntil < 0) return;

    const cardId = direction === 'departure' ? 'departure_predicted_within' : 'arrival_predicted_within';
    await this.homey.flow.getDeviceTriggerCard(cardId).trigger(this, {
      minutes: minutesUntil,
      confidence: prediction.confidence,
      predictedTime: TimeSlots.formatTime(prediction.predictedTime, this.homey.clock.getTimezone()),
    }, {
      minutesUntil,
      occurrenceKey: prediction.predictedTime.toISOString(),
    }).catch(this.error);
  }

  async onSettings() {
    await this._bindSource();
  }

  async onDeleted() {
    this._destroyCapabilityInstances();
    if (this._recomputeInterval) this.homey.clearInterval(this._recomputeInterval);
    if (this._resyncInterval) this.homey.clearInterval(this._resyncInterval);
  }

  async onUninit() {
    this._destroyCapabilityInstances();
  }

}

module.exports = EVChargingPredictorDevice;
