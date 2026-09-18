'use strict';

/**
 * Per-brand charger profiles.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Homey standardised `evcharger_charging_state` (enum: plugged_out,
 * plugged_in, plugged_in_paused, plugged_in_charging, plugged_in_discharging)
 * only in firmware 12.4.5. Every charger app written before that invented its
 * own vocabulary, and nothing forces anyone to migrate - so in a survey of 35
 * real EV charger apps, only ~57% declare it at all. Zaptec, Ohme, Monta,
 * KEBA, ChargeAmps, Amina, Mennekes, go-e (oh2th), Smappee, evcc, GARO and
 * several OCPP apps do not.
 *
 * Worse, Homey Insights only logs number/boolean capabilities, so the standard
 * enum can never be backfilled from history. The only way to give a freshly
 * paired device real history is to read a numeric capability that happens to
 * reveal plug state - in practice the charger's per-phase current, where an
 * idle-but-connected cable draws a small standing current and an unplugged one
 * reads a true zero. But `measure_current` sub-capability names are entirely
 * free-form: the same survey found SEVEN conventions
 * (.p1/.p2/.p3, .L1/.L2/.L3, .l1/.l2/.l3, .phase1/.phase2/.phase3,
 * .phase_a/.phase_b/.phase_c, .a/.b/.c, and KEBA's non-sub-capability
 * measure_current_1/_2/_3), with Easee using two of them in its own app.
 *
 * So supporting another brand is not a code change, it is a handful of facts.
 * This file is where those facts live, so adding a charger is a data-only pull
 * request that needs no understanding of the prediction logic.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD YOUR CHARGER
 * ---------------------------------------------------------------------------
 * Append an entry to PROFILES below. Every field except `id`/`name`/`appIds`
 * is optional - a profile that only fixes one thing is welcome.
 *
 *   id        short slug, lowercase.
 *   name      human-readable brand name.
 *   appIds    the Homey app id(s) this applies to, e.g. 'no.easee'. Find it in
 *             the app's GitHub app.json ("id"), or from the Homey developer
 *             tools (Devices -> your charger -> driverId, which looks like
 *             `homey:app:no.easee:charger` - the app id is the third segment).
 *   source    URL you verified this from. Please fill this in.
 *   notes     anything a future maintainer needs to know.
 *
 *   stateCapability   ONLY for apps that do not declare
 *                     `evcharger_charging_state`. Names the vendor capability
 *                     that reports connection state, and which of its values
 *                     mean "not plugged in":
 *                       { capabilityId: 'charge_mode',
 *                         awayValues: ['Disconnected'] }
 *                     When the standard capability IS present it always wins -
 *                     this is a fallback, not an override.
 *
 *   connectedGuards   Positive evidence that a cable is still attached, used
 *                     ONLY to veto a "plugged_out" reading. Some apps' state
 *                     machines conflate "charging session finished, cable
 *                     still connected" with "unplugged" - a confirmed bug class
 *                     (see the Easee entry below, and a matching fix in
 *                     nl.xseth.wallbox). List the raw status capability and the
 *                     values that really mean connected:
 *                       [{ capabilityId: 'charger_status',
 *                          values: ['Completed'] }]
 *                     NOTE: `charger_status` is used by at least three
 *                     unrelated apps (Easee, myenergi, Ohme) with three totally
 *                     different value sets, which is exactly why guards are
 *                     scoped per app id rather than matched globally.
 *
 *   currentSources    Numeric capabilities whose value reveals plug state, with
 *                     the threshold above which the cable counts as connected:
 *                       [{ capabilityId: 'measure_current.p1',
 *                          pluggedAbove: 0.025 }]
 *                     This is what enables history backfill.
 *
 *                     ---- READ THIS BEFORE ADDING currentSources ----
 *                     Only add these if you have VERIFIED, on your own
 *                     charger, that it reports a small non-zero current while
 *                     a cable is connected but NOT charging, and a true zero
 *                     while unplugged. Do not assume it: under IEC 61851 the
 *                     contactor is open in both of those states, so many
 *                     chargers will read zero for both, and no app surveyed
 *                     infers plug state from current at all. Easee's 0.05 A
 *                     standing current appears to be a quirk, not a rule.
 *
 *                     If you get this wrong the app does not fail loudly - it
 *                     silently learns "departure = the moment charging
 *                     stopped", which is confidently wrong and much worse than
 *                     having no history. To check: open Homey Insights for the
 *                     capability, find a period where the car sat plugged in
 *                     overnight without charging, and confirm the line sits at
 *                     a small non-zero value rather than at zero. Set
 *                     `pluggedAbove` to roughly half that standing value.
 *
 *                     Leaving currentSources out is always safe: the charger
 *                     just starts with no history and learns from live events.
 */

const PROFILES = [
  {
    id: 'easee',
    name: 'Easee',
    appIds: ['no.easee'],
    source: 'https://github.com/ricott/homey-no.easee - lib/enums.js, decodeEnergyChargerMode()',
    // Fallback identification if the device's app id is ever unavailable.
    // Both together are distinctive: myenergi also exposes `charger_status`,
    // but with a completely different vocabulary and no `measure_current.p1`.
    matchCapabilities: ['charger_status', 'measure_current.p1'],
    notes: [
      'Easee collapses internal chargerMode Disconnected(1) AND Completed(4) onto the same',
      'standard value `plugged_out`. Their own code comment says as much: "iOS app says',
      "'Completed', but easee.cloud says 'Car Connected'\". Completed means the session",
      'finished with the cable still attached, so without the guard below every completed',
      'charge looks like a departure.',
      'Standing current measured on a real unit: 0.05 A connected-idle, 0 A unplugged,',
      'several amps charging. measure_power is useless here - it reads 0 in both states.',
      'Beware `measure_current.offered`: that is the allocated/offered amps, not flowing',
      'current, and it stays non-zero regardless of plug state. Do not add it.',
    ].join(' '),

    connectedGuards: [
      // chargerMode values that mean the car is physically connected. Only
      // 'Completed' is actually reachable here (modes mapping to plugged_out
      // are Offline/Standby/Completed/Error), but the others are listed so the
      // intent stays readable if Easee changes its mapping.
      { capabilityId: 'charger_status', values: ['Paused', 'Charging', 'Completed'] },
    ],

    currentSources: [
      { capabilityId: 'measure_current.p1', pluggedAbove: 0.025 },
      { capabilityId: 'measure_current.p2', pluggedAbove: 0.025 },
      { capabilityId: 'measure_current.p3', pluggedAbove: 0.025 },
    ],
  },

  // ---------------------------------------------------------------------------
  // TEMPLATE - copy, fill in, delete the comment markers, and open a PR.
  // This Zaptec sketch is UNVERIFIED and deliberately left disabled: Zaptec
  // declares no standard capability, so it needs a stateCapability entry, and
  // nobody has confirmed its idle-current behaviour.
  // ---------------------------------------------------------------------------
  // {
  //   id: 'zaptec',
  //   name: 'Zaptec Go / Home / Pro',
  //   appIds: ['com.zaptec'],
  //   source: 'https://github.com/PatrickE94/com.zaptec - app.json',
  //   notes: 'Declares neither evcharger_charging_state nor evcharger_charging.',
  //   stateCapability: {
  //     capabilityId: 'charge_mode',
  //     awayValues: ['Disconnected'],
  //   },
  //   // Only add this after verifying the idle-current behaviour - see above.
  //   // currentSources: [
  //   //   { capabilityId: 'measure_current.phase1', pluggedAbove: ... },
  //   // ],
  // },
];

/**
 * Homey device ids look like `homey:app:no.easee:charger`; the app id is the
 * third segment. Older firmwares exposed this as `driverUri` instead, and some
 * callers may hand us a bare app id, so be permissive rather than strict.
 */
function appIdFromDriverId(driverId) {
  if (typeof driverId !== 'string' || driverId.length === 0) return null;
  const match = driverId.match(/^homey:app:([^:]+)/);
  if (match) return match[1];
  if (driverId.includes(':')) return null;
  return driverId;
}

/**
 * The profile for a device, or null when the charger's brand is unknown to us
 * (which is the normal case, and is fine - it just means no brand-specific
 * quirks are applied).
 *
 * Matching is by app id first. `matchCapabilities` is a deliberate safety net:
 * `driverUri` is deprecated and already returns undefined on current
 * firmware, so if `driverId` ever stops being populated too, brand support
 * would silently evaporate - no guards, no backfill - with nothing in the logs
 * to explain it. A distinctive capability fingerprint keeps the profile
 * attached regardless.
 */
function profileForDevice(device) {
  if (!device) return null;

  const appId = appIdFromDriverId(device.driverId || device.driverUri);
  if (appId) {
    const byAppId = PROFILES.find((profile) => profile.appIds.includes(appId));
    if (byAppId) return byAppId;
  }

  const caps = device.capabilitiesObj || {};
  return PROFILES.find((profile) => Array.isArray(profile.matchCapabilities)
    && profile.matchCapabilities.length > 0
    && profile.matchCapabilities.every((capabilityId) => caps[capabilityId])) || null;
}

function connectedGuardsFor(device) {
  const profile = profileForDevice(device);
  return (profile && profile.connectedGuards) || [];
}

function currentSourcesFor(device) {
  const profile = profileForDevice(device);
  return (profile && profile.currentSources) || [];
}

/**
 * The vendor connection-state capability to fall back on for apps that never
 * adopted Homey's standard one. Returns null when there is nothing to fall
 * back to.
 */
function fallbackStateCapabilityFor(device) {
  const profile = profileForDevice(device);
  return (profile && profile.stateCapability) || null;
}

module.exports = {
  PROFILES,
  appIdFromDriverId,
  profileForDevice,
  connectedGuardsFor,
  currentSourcesFor,
  fallbackStateCapabilityFor,
};
