'use strict';

const Homey = require('homey');
const PredictionModel = require('../../lib/PredictionModel');
const TimeSlots = require('../../lib/TimeSlots');
const InsightsBackfill = require('../../lib/InsightsBackfill');
const ChargerConventions = require('../../lib/ChargerConventions');

const DEFAULT_DEBOUNCE_SECONDS = 45;
const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;
const RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PREDICTION_CHANGE_THRESHOLD_MS = 5 * 60 * 1000;
// Bumping this re-runs the one-time history reset + Insights backfill, which is
// how an already-installed device picks up a better backfill source.
const EVENT_SCHEMA_VERSION = 4;

class EVChargingPredictorDevice extends Homey.Device {

  async onInit() {
    this.model = new PredictionModel(this, () => this.homey.clock.getTimezone());
    this._committedPresence = undefined;
    this._debounceTimer = null;
    this._pendingPresence = undefined;
    this._guardInstances = [];
    this._currentInstances = [];
    this._lastPrediction = null;

    // Departure-accuracy logging: the forecast we are currently "betting" on
    // for the next departure, and the last day we already posted a score for
    // (so we grade only the first departure of each day - the one the model
    // actually targets). Both persist so a restart doesn't lose or double-log.
    this._outstandingDeparture = this.getStoreValue('outstandingDeparture') || null;
    this._lastAccuracyLogDay = this.getStoreValue('lastAccuracyLogDay') || null;

    // Devices paired before this capability existed don't get it automatically.
    if (!this.hasCapability('prediction_status')) {
      await this.addCapability('prediction_status').catch(this.error);
    }

    await this.homey.app.apiReadyPromise;
    await this._clearHistoryPollutedByFixedBugs();
    await this._bindSource();
    await this._maybeBackfillFromInsights();

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

  async recomputePredictions() {
    const now = new Date();
    const departure = this.model.predictNext('departure', now);
    const arrival = this.model.predictNext('arrival', now);

    this._trackDepartureOutstanding(departure, now);

    await this._applyPrediction('departure', departure, now);
    await this._applyPrediction('arrival', arrival, now);
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
  // forecast once "now" has passed the predicted time: predictNext then rolls
  // to tomorrow, and grading against that rolled-over value would look like a
  // ~24h miss. All persisted so a restart mid-morning still grades correctly.
  _trackDepartureOutstanding(prediction, now) {
    if (!prediction || !prediction.predictedTime) return;
    const predDay = this._dayKey(prediction.predictedTime);
    const nowDay = this._dayKey(now);
    if (predDay !== nowDay && this._outstandingDeparture) return;

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
    const verdict = errMin === 0 ? 'precies op tijd' : `${abs} min te ${errMin < 0 ? 'vroeg' : 'laat'}`;
    const excerpt = `🚗 Vertrekvoorspelling: voorspeld ${TimeSlots.formatTime(predicted, tz)}, `
      + `werkelijk ${TimeSlots.formatTime(actualDate, tz)} — ${verdict} `
      + `(betrouwbaarheid ${outstanding.confidence}%)`;

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
    const recorded = `${departures} departure day${departures === 1 ? '' : 's'}, ${arrivals} arrival day${arrivals === 1 ? '' : 's'}`;

    let status;
    if (departures + arrivals === 0) {
      status = 'Learning - no trips recorded yet';
    } else if (!departure.predictedTime && !arrival.predictedTime) {
      status = `Learning - ${recorded} recorded`;
    } else if (departure.source === 'forest' || arrival.source === 'forest') {
      status = `Trained model - ${recorded}`;
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
