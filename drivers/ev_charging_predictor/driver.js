'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const ChargerConventions = require('../../lib/ChargerConventions');

const EVCHARGER_CLASS = 'evcharger';

// Offer any evcharger whose connection state we can actually read: Homey's
// standard capability where the app declares it (only ~57% do), or a vendor
// capability named by that brand's entry in ChargerProfiles for the rest. A
// charger we can read neither from simply doesn't appear, rather than pairing
// into a device that would never report anything.
function describeDevices(rawDevices) {
  return Object.values(rawDevices)
    .filter((device) => device.class === EVCHARGER_CLASS)
    .filter((device) => ChargerConventions.resolveStateCapability(device) !== null)
    .map((device) => ({
      id: device.id,
      name: device.name,
      zoneName: (device.zone && device.zone.name) || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Which capability to bind, and what "away" means for it, are resolved once at
// pair/repair time and stored, so the running device doesn't have to re-derive
// brand specifics on every read.
async function buildSettings(api, pending) {
  const device = await api.devices.getDevice({ id: pending.deviceId, $cache: false });
  const state = ChargerConventions.resolveStateCapability(device);
  if (!state) {
    throw new Error('That charger does not expose a connection state this app can read.');
  }
  return {
    homeyDeviceId: pending.deviceId,
    homeyDeviceName: pending.deviceName,
    stateCapabilityId: state.capabilityId,
    awayValues: state.awayValues,
  };
}

class EVChargingPredictorDriver extends Homey.Driver {

  async onInit() {
    this._registerFlowCards();
    this.log('EVChargingPredictorDriver initialized');
  }

  _registerFlowCards() {
    this.homey.flow.getDeviceTriggerCard('departure_predicted_within')
      .registerRunListener((args, state) => this._shouldFireWithin(args, state));
    this.homey.flow.getDeviceTriggerCard('arrival_predicted_within')
      .registerRunListener((args, state) => this._shouldFireWithin(args, state));

    this.homey.flow.getConditionCard('departure_within_minutes')
      .registerRunListener((args) => this._checkWithinMinutes(args, 'predicted_departure_minutes'));
    this.homey.flow.getConditionCard('arrival_within_minutes')
      .registerRunListener((args) => this._checkWithinMinutes(args, 'predicted_arrival_minutes'));
    this.homey.flow.getConditionCard('departure_confidence_above')
      .registerRunListener((args) => this._checkConfidenceAbove(args, 'predicted_departure_confidence'));
    this.homey.flow.getConditionCard('arrival_confidence_above')
      .registerRunListener((args) => this._checkConfidenceAbove(args, 'predicted_arrival_confidence'));
  }

  // state: { minutesUntil, occurrenceKey } set by device.js when it triggers this card.
  // Fires at most once per unique predicted occurrence per configured threshold.
  _shouldFireWithin(args, state) {
    if (state.minutesUntil > args.minutes) return false;
    const device = args.device;
    if (!device._firedThresholds) device._firedThresholds = new Map();
    let fired = device._firedThresholds.get(state.occurrenceKey);
    if (!fired) {
      fired = new Set();
      device._firedThresholds.set(state.occurrenceKey, fired);
    }
    if (fired.has(args.minutes)) return false;
    fired.add(args.minutes);
    return true;
  }

  _checkWithinMinutes(args, capabilityId) {
    const value = args.device.getCapabilityValue(capabilityId);
    return value != null && value <= args.minutes;
  }

  _checkConfidenceAbove(args, capabilityId) {
    const value = args.device.getCapabilityValue(capabilityId);
    return value != null && value > args.percentage;
  }

  async onPair(session) {
    const pending = {};

    session.setHandler('get_bindable_devices', async () => {
      await this.homey.app.apiReadyPromise;
      const devices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 });
      return describeDevices(devices);
    });

    // The device view emits this directly once a charger is picked - there's
    // no separate capability-selection step, since evcharger_charging_state
    // is Homey's standard capability for this device class.
    session.setHandler('save_selection', async (data) => {
      Object.assign(pending, data);
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!pending.deviceId) {
        throw new Error('No charger selected');
      }
      const settings = await buildSettings(this.homey.app.api, pending);
      return [
        {
          name: `${pending.deviceName} Charging Predictor`,
          data: { id: crypto.randomUUID() },
          settings: { ...settings, debounceSeconds: 45 },
        },
      ];
    });
  }

  async onRepair(session, device) {
    const pending = {};

    session.setHandler('get_bindable_devices', async () => {
      await this.homey.app.apiReadyPromise;
      const devices = await this.homey.app.api.devices.getDevices({ $timeout: 15000 });
      return describeDevices(devices);
    });

    session.setHandler('save_selection', async (data) => {
      Object.assign(pending, data);
      return true;
    });

    session.setHandler('confirm_rebind', async () => {
      if (!pending.deviceId) {
        throw new Error('No charger selected');
      }
      await device.setSettings(await buildSettings(this.homey.app.api, pending));
      await device.restartDevice();
      return true;
    });
  }

}

module.exports = EVChargingPredictorDriver;
