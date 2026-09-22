'use strict';

/**
 * Locks in the brand-profile behaviour: Easee keeps everything it had, an
 * unknown charger degrades safely rather than guessing, and a capability id
 * that several unrelated vendors happen to share can't misfire across brands.
 */

const assert = require('assert');
const ChargerConventions = require('../lib/ChargerConventions');
const ChargerProfiles = require('../lib/ChargerProfiles');

function device({ driverId, caps }) {
  const capabilitiesObj = {};
  for (const [id, value] of Object.entries(caps || {})) capabilitiesObj[id] = { value };
  return { driverId, capabilitiesObj };
}

function run() {
  // --- app id parsing -------------------------------------------------------
  assert.strictEqual(ChargerProfiles.appIdFromDriverId('homey:app:no.easee:charger'), 'no.easee');
  assert.strictEqual(ChargerProfiles.appIdFromDriverId('no.easee'), 'no.easee');
  assert.strictEqual(ChargerProfiles.appIdFromDriverId(undefined), null);

  // --- Easee keeps every behaviour it had before profiles existed -----------
  const easee = device({
    driverId: 'homey:app:no.easee:charger',
    caps: {
      evcharger_charging_state: 'plugged_out',
      charger_status: 'Completed',
      'measure_current.p1': 0.05,
    },
  });

  const state = ChargerConventions.resolveStateCapability(easee);
  assert.strictEqual(state.capabilityId, 'evcharger_charging_state');
  assert.deepStrictEqual(state.awayValues, ['plugged_out']);
  assert.ok(ChargerConventions.looksLikeCompletedSessionStillConnected(easee),
    'Easee "Completed" must still veto a false departure');
  assert.ok(ChargerConventions.looksConnectedByCurrent(easee),
    '0.05 A standing current must still read as connected');
  assert.deepStrictEqual(ChargerConventions.guardCapabilityIdsFor(easee), ['charger_status']);
  assert.deepStrictEqual(ChargerConventions.numericSourceIdsFor(easee),
    ['measure_current.p1'], 'only capabilities the device actually exposes');
  assert.strictEqual(ChargerConventions.plugStateSourcesFor(easee).length, 3);

  // Unplugged: no signal contradicts "away".
  const easeeUnplugged = device({
    driverId: 'homey:app:no.easee:charger',
    caps: { evcharger_charging_state: 'plugged_out', charger_status: 'Standby', 'measure_current.p1': 0 },
  });
  assert.ok(!ChargerConventions.looksLikeCompletedSessionStillConnected(easeeUnplugged));
  assert.ok(!ChargerConventions.looksConnectedByCurrent(easeeUnplugged));

  // Identified by capability fingerprint when the app id is missing.
  const easeeNoDriverId = device({
    caps: { evcharger_charging_state: 'plugged_out', charger_status: 'Completed', 'measure_current.p1': 0.05 },
  });
  assert.ok(ChargerConventions.looksLikeCompletedSessionStillConnected(easeeNoDriverId),
    'profile must survive a missing driverId');

  // --- an unknown brand degrades safely, it does not guess ------------------
  // Alfen: standard capability present, but a current naming we have not
  // verified. It must pair and track state, and must NOT backfill.
  const alfen = device({
    driverId: 'homey:app:com.alfen:alfen',
    caps: {
      evcharger_charging_state: 'plugged_in_charging',
      'measure_current.l1': 0.0,
      operatingmode: 'charging',
    },
  });
  assert.strictEqual(ChargerConventions.resolveStateCapability(alfen).capabilityId,
    'evcharger_charging_state', 'unknown brands still pair on the standard capability');
  assert.deepStrictEqual(ChargerConventions.plugStateSourcesFor(alfen), [],
    'no backfill from an unverified current signal');
  assert.ok(!ChargerConventions.looksConnectedByCurrent(alfen));
  assert.deepStrictEqual(ChargerConventions.guardCapabilityIdsFor(alfen), []);

  // --- cross-vendor capability-id collision must not misfire ---------------
  // myenergi and Ohme both expose a capability literally named
  // `charger_status`, with vocabularies unrelated to Easee's.
  const myenergi = device({
    driverId: 'homey:app:net.biseth.myenergi:zappi',
    caps: { evcharger_charging_state: 'plugged_out', charger_status: 'C2', measure_current: 0 },
  });
  assert.ok(!ChargerConventions.looksLikeCompletedSessionStillConnected(myenergi),
    "Easee's guard values must not be applied to myenergi");

  const ohme = device({
    driverId: 'homey:app:io.jak.ohme:ohme',
    caps: { evcharger_charging_state: 'plugged_out', charger_status: 'paused' },
  });
  assert.ok(!ChargerConventions.looksLikeCompletedSessionStillConnected(ohme),
    "Easee's guard values must not be applied to Ohme");

  // --- Zaptec now pairs via its profile's fallback state capability --------
  const zaptec = device({
    driverId: 'homey:app:com.zaptec:go',
    caps: { charge_mode: 'Disconnected', 'measure_current.phase1': 0 },
  });
  const zaptecState = ChargerConventions.resolveStateCapability(zaptec);
  assert.strictEqual(zaptecState.capabilityId, 'charge_mode',
    'a profiled charger without the standard capability pairs on its fallback');
  assert.deepStrictEqual(zaptecState.awayValues, ['Disconnected']);
  assert.deepStrictEqual(ChargerConventions.plugStateSourcesFor(zaptec), [],
    'source-derived profiles never backfill (no verified current source)');

  // --- a charger with neither the standard capability nor a profile is not
  //     offered for pairing --------------------------------------------------
  const mystery = device({
    driverId: 'homey:app:com.example.mystery:charger',
    caps: { some_status: 'idle' },
  });
  assert.strictEqual(ChargerConventions.resolveStateCapability(mystery), null,
    'no readable state capability -> not pairable');

  // --- source-derived fallbacks: string enum and boolean signals -----------
  const garo = device({
    driverId: 'homey:app:com.softblockrefinery.garo-charger-meter:glbdc',
    caps: { connector: 'CHARGING' },
  });
  const garoState = ChargerConventions.resolveStateCapability(garo);
  assert.strictEqual(garoState.capabilityId, 'connector');
  assert.deepStrictEqual(garoState.awayValues, ['NOT_CONNECTED']);

  const smappee = device({
    driverId: 'homey:app:com.smappee:ev-wall',
    caps: { cable_connected: true },
  });
  const smappeeState = ChargerConventions.resolveStateCapability(smappee);
  assert.strictEqual(smappeeState.capabilityId, 'cable_connected');
  assert.deepStrictEqual(smappeeState.awayValues, [false],
    'a boolean away value survives as a boolean, not a string');
  // boolean away matching works end to end: false = away, true = present.
  assert.strictEqual(ChargerConventions.resolveAwayValues({ awayValues: [false] }).includes(false), true);
  assert.strictEqual(ChargerConventions.resolveAwayValues({ awayValues: [false] }).includes(true), false);

  // --- Wallbox declares the standard capability but mis-reports plugged_out
  //     while the cable is attached; the raw `status` guard vetoes the false
  //     departure, and only a true "Disconnected" is believed ---------------
  const wallboxIdle = device({
    driverId: 'homey:app:nl.xseth.wallbox:wallbox',
    caps: { evcharger_charging_state: 'plugged_out', status: 'Ready' },
  });
  assert.strictEqual(ChargerConventions.resolveStateCapability(wallboxIdle).capabilityId,
    'evcharger_charging_state', 'Wallbox still pairs on the standard capability');
  assert.ok(ChargerConventions.looksLikeCompletedSessionStillConnected(wallboxIdle),
    'status "Ready" (connected-idle) must veto a false departure');

  const wallboxGone = device({
    driverId: 'homey:app:nl.xseth.wallbox:wallbox',
    caps: { evcharger_charging_state: 'plugged_out', status: 'Disconnected' },
  });
  assert.ok(!ChargerConventions.looksLikeCompletedSessionStillConnected(wallboxGone),
    'status "Disconnected" is a real departure, not vetoed');

  // --- awayValues resolution ------------------------------------------------
  assert.deepStrictEqual(ChargerConventions.resolveAwayValues({}), ['plugged_out']);
  assert.deepStrictEqual(
    ChargerConventions.resolveAwayValues({ awayValues: ['Disconnected'] }),
    ['Disconnected'], 'a profile-derived value stored at pairing must be honoured',
  );
  assert.deepStrictEqual(
    ChargerConventions.resolveAwayValues({ awayValues: ['Disconnected'], awayValuesOverride: 'a, b' }),
    ['a', 'b'], 'the user override still wins',
  );

  // --- verification flags track what has been confirmed on hardware --------
  const byId = Object.fromEntries(ChargerProfiles.PROFILES.map((p) => [p.id, p]));
  assert.strictEqual(byId.easee.stateVerified, true, 'Easee is hardware-verified');
  assert.strictEqual(byId.easee.backfillVerified, true, 'Easee backfill is hardware-verified');
  assert.strictEqual(byId.zaptec.stateVerified, false, 'source-derived profiles start unverified');
  for (const p of ChargerProfiles.PROFILES) {
    assert.strictEqual(typeof p.stateVerified, 'boolean', `${p.id} declares stateVerified`);
    assert.strictEqual(typeof p.backfillVerified, 'boolean', `${p.id} declares backfillVerified`);
    // A profile may only claim a verified backfill if it actually ships currentSources.
    if (p.backfillVerified) {
      assert.ok(Array.isArray(p.currentSources) && p.currentSources.length > 0,
        `${p.id} claims backfillVerified but has no currentSources`);
    }
  }

  console.log('OK: brand profiles preserve Easee, fail safe elsewhere, and do not cross-misfire.');
}

run();
