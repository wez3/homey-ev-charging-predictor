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
 *
 *   stateVerified     true once the stateCapability / away-value has been
 *                     confirmed on a real charger of this brand (see TESTING.md).
 *                     Source-derived profiles start false - they still work, this
 *                     just tracks what has been checked on hardware.
 *   backfillVerified  true once the idle-current behaviour has been confirmed via
 *                     Insights, which is the prerequisite for adding currentSources.
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
    stateVerified: true, // confirmed on a real Easee
    backfillVerified: true, // 0.05 A idle current confirmed -> currentSources enabled
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
      { capabilityId: 'charger_status', values: ['Paused', 'Charging', 'Completed', 'Car connected'] },
    ],

    currentSources: [
      { capabilityId: 'measure_current.p1', pluggedAbove: 0.025 },
      { capabilityId: 'measure_current.p2', pluggedAbove: 0.025 },
      { capabilityId: 'measure_current.p3', pluggedAbove: 0.025 },
    ],
  },

  // ---------------------------------------------------------------------------
  // Chargers that never adopted `evcharger_charging_state`. Each entry names the
  // vendor capability to read connection state from, and the value(s) meaning
  // "cable out". All of these were derived from the app's PUBLIC source (see the
  // `source` on each) and NOT verified on hardware - so none declares
  // `currentSources` (that needs a physical idle-current check, per the warning
  // above; only Easee has it). Matching is by app id, deliberately: several of
  // these reuse generic capability ids (`status`, `charger_status`, `connector`)
  // that other apps also expose with unrelated meanings.
  // ---------------------------------------------------------------------------
  {
    id: 'zaptec',
    name: 'Zaptec Go / Go 2 / Home / Pro',
    appIds: ['com.zaptec'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/PatrickE94/com.zaptec - lib/zaptec/enums.ts, .homeycompose/capabilities/charge_mode.json',
    notes: [
      'charge_mode is a string enum: Disconnected, "Connecting to car", Charging,',
      '"Charging finished", Unknown. Only Disconnected is cable-out; "Charging',
      'finished" is a completed session with the cable still attached.',
    ].join(' '),
    stateCapability: { capabilityId: 'charge_mode', awayValues: ['Disconnected'] },
  },

  {
    id: 'ohme',
    name: 'Ohme ePod / Go / Home / Home Pro',
    appIds: ['io.jak.ohme'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/jak/io.jak.ohme - app.json (charger_status enum)',
    notes: [
      'charger_status enum: unplugged, plugged_in, charging, paused,',
      'pending_approval, finished. Only unplugged is cable-out; finished keeps the',
      'cable attached. (Ohme reuses the id charger_status like Easee/myenergi but',
      'with its own vocabulary - hence app-id matching, never capability name.)',
    ].join(' '),
    stateCapability: { capabilityId: 'charger_status', awayValues: ['unplugged'] },
  },

  {
    id: 'mennekes',
    name: 'Mennekes AMTRON (Modbus)',
    appIds: ['mennekes.modbus'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/tjarb/mennekes.modbus - drivers/amtron/device.js (Modbus reg 104 -> OCPP status)',
    notes: [
      'operational_status is a free-form string from the OCPP 1.6 ChargePointStatus',
      'set. It passes through i18n, but every shipped locale maps the key to the',
      'identical English word, so match the literal "Available" (idle, no vehicle)',
      'as the only away value; Preparing/Charging/Suspended/Finishing/Occupied all',
      'mean a cable is attached.',
    ].join(' '),
    stateCapability: { capabilityId: 'operational_status', awayValues: ['Available'] },
  },

  {
    id: 'go-e',
    name: 'go-e Charger HOME / HOMEfix / Gemini',
    appIds: ['com.go-e.charger'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/oh2th-homey/com.go-e.charger - .homeycompose/capabilities/status.json',
    notes: [
      'status enum: station_idle ("No car connected"), car_charging,',
      'station_waiting ("Waiting for car"), car_finished ("Charging stopped").',
      'Only station_idle is cable-out; station_waiting and car_finished keep the',
      'cable attached. (A boolean is_connected also exists; the enum carries more',
      'state, so it is used here.)',
    ].join(' '),
    stateCapability: { capabilityId: 'status', awayValues: ['station_idle'] },
  },

  {
    id: 'smappee',
    name: 'Smappee EV Wall / EV Line',
    appIds: ['com.smappee'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/edwinvdpol/homey-smappee - drivers/ev-wall/driver.compose.json',
    notes: [
      'cable_connected is a boolean: false = cable disconnected (away). Do not',
      'confuse it with connection_state (network reachability) or charging (charge',
      'activity), neither of which is a plug indicator.',
    ].join(' '),
    stateCapability: { capabilityId: 'cable_connected', awayValues: [false] },
  },

  {
    id: 'evcc',
    name: 'evcc (loadpoint)',
    appIds: ['com.evcc.io'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/rdvnit/com.evcc.io - drivers/loadpoint/device.js (evcc_connected = lp.connected)',
    notes: [
      'evcc_connected is a boolean straight from the evcc API lp.connected:',
      'false = vehicle not plugged in (away). evcc_charge_mode (off/smart/now/pv/',
      'minpv) is a control mode, not a connection state.',
    ].join(' '),
    stateCapability: { capabilityId: 'evcc_connected', awayValues: [false] },
  },

  {
    id: 'garo',
    name: 'GARO GLB / GLBDC',
    appIds: ['com.softblockrefinery.garo-charger-meter'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/flexergi/homey-garo-charger-glb - types/connector-status.ts',
    notes: [
      'connector is a string enum: DISABLED, NOT_CONNECTED, CONNECTED, CHARGING,',
      'CHARGING_FINISHED. Only NOT_CONNECTED is cable-out; CHARGING_FINISHED keeps',
      'the cable attached and DISABLED (charger switched off) is ambiguous, so',
      'neither counts as away.',
    ].join(' '),
    stateCapability: { capabilityId: 'connector', awayValues: ['NOT_CONNECTED'] },
  },

  {
    id: 'ocpp',
    name: 'OCPP Server (generic OCPP 1.6 chargers)',
    appIds: ['nl.pulsive.ocpp', 'com.dnetlabs.ocpp'],
    stateVerified: false, // source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/erdebee/homey-ocpp - .homeycompose/capabilities/charging_status.json',
    notes: [
      'Generic OCPP central-system app. charging_status is the raw OCPP 1.6',
      'StatusNotification enum: Available, Preparing, Charging, SuspendedEVSE,',
      'SuspendedEV, Finishing, Reserved, Unavailable, Faulted. Only Available',
      '(connector free) is a firm away signal; the boolean `connected` is the',
      'websocket link to the server, NOT the cable. The store may report the id as',
      'com.dnetlabs.ocpp (rename/fork), so both are matched; the fallback only',
      'applies when charging_status is actually present.',
    ].join(' '),
    stateCapability: { capabilityId: 'charging_status', awayValues: ['Available'] },
  },

  {
    id: 'keba',
    name: 'KEBA P30 / P20',
    appIds: ['se.cohen.keba'],
    stateVerified: false, // source-derived (older public snapshot); confirm on hardware (TESTING.md)
    backfillVerified: false, // no currentSources; needs an Insights idle-current check
    source: 'https://github.com/TheHomeyAppBackupRepositories/se.cohen.keba-1 - drivers/keba-p30/device.js',
    notes: [
      'plug_status is a boolean set from KEBA Plug field 5/7 (cable plugged and',
      'locked at the vehicle): false = not connected (away). Verified against a',
      'public but older snapshot; if a current release added the standard',
      'capability, that wins automatically and this fallback is simply unused.',
    ].join(' '),
    stateCapability: { capabilityId: 'plug_status', awayValues: [false] },
  },

  // ---------------------------------------------------------------------------
  // Chargers that DO declare `evcharger_charging_state` but mis-report it - they
  // pair on the standard capability, and only need a guard to stop a false
  // departure. (Same bug class as Easee's "Completed".)
  // ---------------------------------------------------------------------------
  {
    id: 'wallbox',
    name: 'Wallbox (Pulsar / Commander)',
    appIds: ['nl.xseth.wallbox'],
    stateVerified: false, // guard is source-derived; confirm on real hardware (TESTING.md)
    backfillVerified: false, // guard-only profile, no currentSources
    source: 'https://github.com/rkokkelk/nl.xseth.wallbox - drivers/wallbox/device.js, lib/statuses.js; issue #57',
    notes: [
      'Declares evcharger_charging_state, but two mismappings drive it to',
      'plugged_out while the cable is attached: statuses.js maps Error/Updating ->',
      'plugged_out, and triggerStatusChange() overrides the state to plugged_out on',
      'status "Ready" (connected-idle). The raw status capability is ground truth:',
      'only "Disconnected" is a real unplug. Guard on the clearly-attached',
      'statuses; Error/Updating are left unguarded on purpose, so a real departure',
      'during a fault is not suppressed (the worse failure).',
    ].join(' '),
    connectedGuards: [
      { capabilityId: 'status', values: ['Ready', 'Waiting', 'Charging', 'Paused', 'Locked', 'Discharging'] },
    ],
  },

  // ---------------------------------------------------------------------------
  // TEMPLATE - copy, fill in, delete the comment markers, and open a PR.
  // Add a stateCapability for an app that lacks evcharger_charging_state, and/or
  // a connectedGuard for one that mis-reports it. Only add currentSources after
  // verifying the idle-current behaviour on your own charger (see the warning
  // at the top of this file). Always fill in `source`.
  // ---------------------------------------------------------------------------
  // {
  //   id: 'yourcharger',
  //   name: 'Your Charger',
  //   appIds: ['com.example.charger'],
  //   stateVerified: false,    // flip to true once confirmed on real hardware
  //   backfillVerified: false, // true only after an Insights idle-current check
  //   source: 'https://github.com/.../app.json - <what you verified>',
  //   notes: 'Which capability, which values mean cable-out, and any quirks.',
  //   stateCapability: { capabilityId: 'charge_mode', awayValues: ['Disconnected'] },
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
