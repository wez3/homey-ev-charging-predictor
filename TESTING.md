# Testing the EV Charging Predictor on real hardware

Only **Easee** is verified on real hardware. Every other charger profile in
`lib/ChargerProfiles.js` was derived from the app's public source and is marked
`stateVerified: false` / `backfillVerified: false`. This document is how those
get confirmed - by test users, over the Homey test channel.

The key idea: **don't test the predictions** (they take weeks to become useful).
Test the **plug detection** - the `car_present` capability - which reacts within
the debounce (~45s). If `car_present` tracks the cable correctly, the profile's
`stateCapability` / away-value is right.

## Running a test release (no community needed)

1. `npx homey app publish` - uploads a build to your Developer Portal.
2. In the portal (`tools.developer.homey.app`), set that build to **Test**. A
   test build does **not** need Athom certification; only a Live (public) build
   does.
3. Share the public test URL - anyone with the link can install it, no tester
   registry required:
   `https://homey.app/a/com.evcharging.predictor/test/`
4. Recruit per brand on the Homey Community Forum (`community.homey.app`),
   r/homey, or directly. You need only one good report per brand.
5. Fix `lib/ChargerProfiles.js` on any bad report, publish a new test build, ask
   the tester to update and re-check. Flip `stateVerified` / `backfillVerified`
   to `true` as brands are confirmed.

## What to ask a tester

### Test 1 - Plug detection (everyone, ~5 min) -> confirms `stateVerified`

1. Install via the test link and add a device: **EV Charging Predictor** -> pick
   your charger. *(If your charger isn't in the list, its brand isn't recognised
   yet - report that.)*
2. Watch the **"Car present"** tile:
   - **Unplug the cable** -> `car_present` must go **false** within ~1 min.
   - **Plug in** -> **true**.
   - **Let a charge finish with the cable still in** (or plug in without
     charging) -> `car_present` must **stay true** (no false "departure").

### Test 2 - Current check (optional, per brand) -> confirms `backfillVerified`

This is what lets backfill (real history from day one) be switched on for a
brand. Higher bar: a wrong `currentSources` corrupts both the backfill *and* the
live veto, so only add it with clear evidence. Many chargers read 0 A whether
connected-idle or unplugged (IEC 61851 opens the contactor in both), and those
simply don't qualify - which is fine.

1. Find the **current** capability on the charger device (`measure_current`,
   `measure_current.p1` / `.l1` / `.phase1` / `.a`, `measure_current_1`, ...).
   *Not `measure_power` - it reads 0 in both states.*
2. Open **Homey Insights** for that capability.
3. Find a window where the car was **plugged in but NOT charging** (e.g.
   overnight after a full charge).
4. Report the reading while **connected-idle** vs **unplugged**, with a
   screenshot. Backfill is only safe if connected-idle is a small non-zero value
   and unplugged is a true zero; then `pluggedAbove` is set to about half the
   idle value.

## Report form (copy-paste)

```
--- Test 1: plug detection ---
- Brand / model:
- Charger app + version:
- Homey firmware:
- Appeared in the picker?                 yes / no
- car_present -> false on unplug?         yes / no  (after ~how many sec?)
- car_present stayed true after charge/idle? yes / no
- Anything odd in the timeline?

--- Test 2 (optional): current ---
- Current capability id(s):
- Reading when plugged in + NOT charging: ... A   (Insights screenshot)
- Reading when unplugged:                 ... A
```
