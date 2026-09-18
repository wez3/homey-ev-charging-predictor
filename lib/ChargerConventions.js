'use strict';

const ChargerProfiles = require('./ChargerProfiles');

/**
 * Homey's standard EV charger capability (documented at
 * apps.developer.homey.app/the-basics/devices/energy, added in firmware
 * v12.4.5): every conformant `evcharger`-class app is expected to expose this
 * exact capability so state can be read generically across brands, which is
 * why pairing doesn't need to ask the user to pick a capability - only which
 * charger. `STATE_SETTING_OVERRIDE_KEY` is a per-device settings escape hatch
 * in case some app's exact value differs.
 *
 * Confirmed (not guessed) values, from homey-lib's own capability definition:
 * plugged_out, plugged_in, plugged_in_paused, plugged_in_charging,
 * plugged_in_discharging - with `plugged_out` meaning unplugged.
 *
 * In practice only about 57% of real charger apps declare it (surveyed across
 * 35 apps), so `ChargerProfiles` can name a vendor capability to fall back on
 * for the rest. Everything brand-specific - fallback state capabilities,
 * false-departure guards and plug-revealing current capabilities - lives in
 * that file so supporting a new charger is a data-only change. This module is
 * just the standard behaviour plus the lookups that consult it.
 */
const STATE_CAPABILITY_ID = 'evcharger_charging_state';
const DEFAULT_AWAY_VALUES = ['plugged_out'];
const STATE_SETTING_OVERRIDE_KEY = 'awayValuesOverride';

function capabilitiesOf(device) {
  return (device && device.capabilitiesObj) || {};
}

/**
 * Which capability to read connection state from, and which of its values mean
 * "not plugged in". Homey's standard capability always wins; a brand profile
 * only fills in for apps that never adopted it. Returns null when neither is
 * available, i.e. this device can't be used at all.
 */
function resolveStateCapability(device) {
  const caps = capabilitiesOf(device);
  if (Object.prototype.hasOwnProperty.call(caps, STATE_CAPABILITY_ID)) {
    return { capabilityId: STATE_CAPABILITY_ID, awayValues: DEFAULT_AWAY_VALUES };
  }

  const fallback = ChargerProfiles.fallbackStateCapabilityFor(device);
  if (fallback && Object.prototype.hasOwnProperty.call(caps, fallback.capabilityId)) {
    return {
      capabilityId: fallback.capabilityId,
      awayValues: Array.isArray(fallback.awayValues) ? fallback.awayValues : [],
    };
  }

  return null;
}

/**
 * The values meaning "away" for an already-paired device. The user's advanced
 * per-device override wins; otherwise whatever pairing resolved and stored
 * (which is the standard value for conformant chargers, or a brand profile's
 * for the rest); falling back to the standard as a last resort.
 */
function resolveAwayValues(settings) {
  const override = settings[STATE_SETTING_OVERRIDE_KEY];
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (Array.isArray(settings.awayValues) && settings.awayValues.length > 0) {
    return settings.awayValues;
  }
  return DEFAULT_AWAY_VALUES;
}

/**
 * True if a brand guard says a cable is still attached despite the state
 * capability reading "away".
 *
 * Some apps' state machines conflate "charging session completed, cable still
 * connected" with "actually unplugged" - confirmed for Easee, and a matching
 * fix exists against the unrelated nl.xseth.wallbox, so it's a recurring bug
 * class rather than one vendor's mistake. Guards are scoped per app id in
 * ChargerProfiles, which matters: at least three unrelated apps (Easee,
 * myenergi, Ohme) expose a capability literally called `charger_status` with
 * three completely different value vocabularies, so matching on capability id
 * alone would eventually misfire.
 */
function looksLikeCompletedSessionStillConnected(device) {
  const caps = capabilitiesOf(device);
  return ChargerProfiles.connectedGuardsFor(device).some(({ capabilityId, values }) => {
    const cap = caps[capabilityId];
    return cap && Array.isArray(values) && values.includes(cap.value);
  });
}

/**
 * True if the charger's live per-phase current says a cable is connected.
 *
 * Physical evidence rather than a vendor state machine, so it can't conflate
 * "session finished" with "unplugged". It is also the same signal the Insights
 * backfill reads, so for chargers with a profile the live veto and the learned
 * history agree on what "plugged in" means.
 *
 * Only applies to chargers whose profile declares currentSources, because the
 * underlying assumption - a small standing current while connected but idle,
 * a true zero while unplugged - is brand-specific and, per IEC 61851, false
 * for many chargers. Unknown brands contribute nothing here rather than
 * guessing. See the warning in ChargerProfiles.
 */
function looksConnectedByCurrent(device) {
  const caps = capabilitiesOf(device);
  return ChargerProfiles.currentSourcesFor(device).some(({ capabilityId, pluggedAbove }) => {
    const cap = caps[capabilityId];
    return cap && typeof cap.value === 'number' && cap.value > pluggedAbove;
  });
}

/**
 * The guard capabilities this charger actually exposes, so they can be
 * subscribed to alongside the state capability.
 */
function guardCapabilityIdsFor(device) {
  const caps = capabilitiesOf(device);
  return ChargerProfiles.connectedGuardsFor(device)
    .map(({ capabilityId }) => capabilityId)
    .filter((capabilityId) => caps[capabilityId]);
}

/**
 * Which of the current capabilities this charger actually exposes.
 *
 * These have to be subscribed to, not just read on demand: looksConnectedByCurrent
 * is only meaningful against a *live* value. Read from a stale snapshot it is
 * strictly harmful - a current reading left over from when the cable was still
 * connected vetoes a real departure, and never the reverse, so unplugging goes
 * unnoticed until something else refreshes the device.
 */
function numericSourceIdsFor(device) {
  const caps = capabilitiesOf(device);
  return ChargerProfiles.currentSourcesFor(device)
    .map(({ capabilityId }) => capabilityId)
    .filter((capabilityId) => caps[capabilityId]);
}

/**
 * Sources for the Insights history backfill: [{ capabilityId, pluggedAbove }].
 * Empty for a charger with no profile, in which case the device simply starts
 * with no history and learns from live events instead.
 */
function plugStateSourcesFor(device) {
  return ChargerProfiles.currentSourcesFor(device);
}

module.exports = {
  STATE_CAPABILITY_ID,
  DEFAULT_AWAY_VALUES,
  STATE_SETTING_OVERRIDE_KEY,
  resolveStateCapability,
  resolveAwayValues,
  looksLikeCompletedSessionStillConnected,
  looksConnectedByCurrent,
  guardCapabilityIdsFor,
  numericSourceIdsFor,
  plugStateSourcesFor,
};
