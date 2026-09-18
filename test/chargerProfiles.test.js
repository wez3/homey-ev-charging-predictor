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

  // --- a charger we cannot read at all is not offered for pairing -----------
  const zaptec = device({
    driverId: 'homey:app:com.zaptec:go',
    caps: { charge_mode: 'Disconnected', 'measure_current.phase1': 0 },
  });
  assert.strictEqual(ChargerConventions.resolveStateCapability(zaptec), null,
    'no readable state capability -> not pairable (until a profile adds one)');

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

  console.log('OK: brand profiles preserve Easee, fail safe elsewhere, and do not cross-misfire.');
}

run();
