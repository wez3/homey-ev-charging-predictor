# EV Charging Predictor

Predicts when your car will depart or arrive, learning from your EV charger's
connection-state signal (e.g. `evcharger_charging_state`: `plugged_out` /
`plugged_in_charging`). Runs entirely locally on your Homey Pro, no cloud calls.
Exposes the prediction as Flow cards so your own energy-management flows (e.g. that
same charger + a dynamic-pricing app) can pre-condition charging to finish right before
a predicted departure.

For now this only supports EV charger devices (class `evcharger`) - not generic
presence sensors, GPS trackers, or other car integrations. The charger's plug state is
universal (every EV charger app must expose some connection state) and directly
reflects what a charging schedule actually cares about: not "is the car home," but "is
it plugged in and available to charge."

## How it works

1. **Pair an "EV Charging Predictor" device** by picking an existing EV charger device
   - that's the whole wizard. `evcharger_charging_state` is Homey's standard capability
   for this device class (documented, added in firmware v12.4.5), so there's nothing to
   configure: the app binds it directly and treats `plugged_out` as "away," everything
   else as "plugged in." If your charger app ever reports a different literal value for
   unplugged, there's an advanced per-device setting ("Custom unplugged value(s)") to
   override it.

   One confirmed real bug is handled automatically: some charger apps' own state
   machines conflate "charging session completed" with "actually unplugged" - Easee's
   `evcharger_charging_state` reports `plugged_out` for both "Disconnected" *and*
   "Completed" (session finished, cable still connected; their own source comment says
   as much). Easee also exposes the un-collapsed raw status separately as
   `charger_status`. When that capability is present and currently reads "Completed,"
   a `plugged_out` reading is treated as still present instead of a false departure -
   entirely charger-local, so there's no separate device to link and no staleness risk
   (an earlier version tried cross-referencing a linked car's own status instead, but
   EV telemetry apps commonly poll infrequently and go stale for hours while the car
   sleeps, which risked suppressing *real* departures indefinitely - reverted in favor
   of this simpler, charger-only fix). No-ops harmlessly for charger apps that don't
   expose `charger_status`.

   The app subscribes to every signal it judges presence from - the state capability,
   the raw status guard, and each per-phase current - rather than only the state
   capability. That matters because "away" is only believed when nothing contradicts
   it, so a *stale* contradicting reading silently suppresses a real departure. Reading
   the current from a snapshot refreshed only by the 5-minute poll meant unplugging the
   car went unnoticed for minutes; the veto is one-directional, so it delayed departures
   but never arrivals.

   This exact fix is Easee-specific (its capability id and values), but the underlying
   bug class isn't unique to Easee - a different charger app (`nl.xseth.wallbox`) has a
   confirmed fix for the same category of issue with its own vocabulary. Rather than a
   per-user Homey setting (a charger app's internal capability naming isn't something a
   user could reasonably be expected to look up), all brand quirks live as data in
   `lib/ChargerProfiles.js` - see [Adding another charger](#adding-another-charger).
2. On first init, the app does a one-time **backfill from Homey's own Insights
   history**, so a freshly paired device starts with real history instead of nothing.
   The bound state capability itself can never be backfilled - Homey Insights only logs
   number/boolean capabilities, and connection state is an enum - so it falls back to
   the charger's **per-phase current**, which does encode plug state: an idle but
   connected cable still draws a small standing current (0.05 A on the confirmed
   Easee), while an unplugged one reads a true zero. (`measure_power` is useless for
   this - it reads 0 in both cases.)

   Homey's Insights API has no date-range paging (`getLogEntries` takes only a log id
   and one of a fixed set of named resolutions), and Homey sizes the buckets to fit
   whatever span you ask for. Measured against a real charger: `last7Days`/`lastWeek`/
   `thisWeek` are hourly, **`last14Days` is hourly too** (336 entries, a full 14 days),
   and anything month-scale (`last31Days`, `lastMonth`) drops to **6-hourly**. So 14
   days is the ceiling at usable precision, and the backfill takes it in one call,
   keeping `last7Days` only as insurance (windows are merged, duplicate timestamps
   dropped, and anything coarser than ~70 min buckets is rejected rather than trained
   on). It degrades silently to collecting events live if nothing is found.

   Hourly buckets are averages, so the hour containing a departure reads part-way
   between "idle but connected" and zero, and can cross the threshold back and forth -
   faking an "arrived, then left again" pair either side of the one real departure. The
   backfill therefore applies a 90-minute minimum dwell, the history equivalent of the
   live path's debounce. On real data 14 days yielded 22 raw transitions but 14 real
   events once those blips were collapsed.

   Going past 14 days was investigated and rejected on measurements, not assumption. A
   6-hourly bucket's *value* does encode timing - idle-but-connected is a known constant
   (0.05 A), so a bucket straddling a single unplug reads the fraction of the bucket the
   cable was connected, which places the edge to within minutes. It works, but on 31
   days of real data it recovered only 9 events, versus 14 from 14 days of hourly data:
   any 6-hour bucket containing a charging session averages far above idle and hides the
   plug edge completely, so it only ever sees the subset of days with no charging. Worse
   data, biased sample, more code - not worth it.
3. Each committed plug/unplug transition (debounced to ignore flicker) is logged as a
   departure (unplugged) or arrival (plugged in) event, bucketed by weekday.
4. Predictions start immediately using a **weighted kernel density estimate (KDE)**
   over historical time-of-day per weekday. Samples are weighted by recency (6-week
   half-life), and a weekday borrows from its neighbours (0.35) and more weakly from
   other days of the same type - workday or weekend (0.2), because two weeks of history
   is only *one* observation per weekday and commutes are shaped more by "workday vs
   weekend" than by which workday it is.

   An earlier version switched to a trained Random Forest once ~20 days were recorded.
   It was removed after a walk-forward simulation (14 weeks, three schedule types)
   showed it was consistently *less* accurate than the KDE on workdays - e.g. 82% vs
   93% of predictions within 15 minutes for a regular commuter. With one training row
   per day and little signal in its features, it mostly fit noise.
5. Predicted times and confidence are exposed as device capabilities, plus Flow
   trigger/condition cards you can wire into your own charging automations.

6. **Daily charge need.** Separately from the time predictions, the app predicts how
   many kWh the car will need *tomorrow*, from the charger's own cumulative energy
   meter (`meter_power`). It keeps one reading per calendar day (the latest wins), so
   a day's energy is simply the rise in the meter across it. Per day rather than per
   plug-in session on purpose: a home charger is often left connected for days and
   tops up in bursts on cheap hours, which makes "energy per session" an unstable
   unit, while energy per day is exactly what a day-ahead plan needs.

   The estimate is a recency-weighted median (30-day half-life) with a 10th-90th
   percentile band, conditioned on tomorrow's weekday: that weekday's own history is
   blended with the all-days estimate, leaning on the weekday once it has a few days
   of data. Days that follow a gap, or where the meter went backwards or rose
   implausibly (> 150 kWh), are dropped rather than guessed. On first init the log is
   seeded once from the meter's Insights history, so it shows real numbers straight
   away. It's exposed as the `predicted_charge_kwh` capability, a *"daily charge need
   above X kWh"* condition and a *"daily charge need changed"* trigger (fires on a
   move of at least 0.5 kWh, with low/high band tokens). Once a day is over, the
   timeline shows how the prediction compared with what was actually used. Chargers
   without a cumulative `meter_power` simply show no value.

**What confidence means.** It is the product of how much history backs the prediction
and how *concentrated* that history is around the predicted time - the share of the
weighted samples that land near it, and how tightly they cluster. It used to count
samples only, which meant a car leaving at 08:00 +/- 3 min every day scored the same as
one leaving anywhere between 06:00 and 11:00, and (because samples are bucketed per
weekday) nothing could exceed ~35% until about eight weeks had passed. A Flow condition
like `confidence > 60%` now means something. Note that a genuinely irregular schedule
will still report a low number, and that is the honest answer rather than a bug: with
14 days of history a weekday has exactly one observation of its own, which is not
enough to tell a pattern from a coincidence. That number climbs on its own as the app
accumulates live events week over week.

This app never controls the charger directly - it only predicts. Combine its Flow
cards with your existing charger/price-aware Flows, e.g.: *"IF departure predicted
within 90 min AND confidence > 60% AND price is low -> start charging."*

## Setup

```
npm install -g homey   # or use npx homey
homey login
```

From this directory:

```
npm install
npx homey app build      # regenerates app.json from .homeycompose/ + drivers/*/driver.compose.json
npx homey app validate   # static structure check - already passing at `publish` level
npx homey app run        # sideload onto your Homey Pro with live logs
```

Then in the Homey app: add a device, pick "EV Charging Predictor," and choose your
charger - one step, done.

## Project layout

- `app.js` - connects to `homey-api` once at startup so the app can read/subscribe to
  the charger device.
- `drivers/ev_charging_predictor/` - the virtual predictor device: one-step
  pairing/repair (just pick a charger), capability binding, and the recompute loop.
- `lib/ChargerProfiles.js` - **the per-brand data file** (see below). All charger-specific
  knowledge lives here and nowhere else.
- `lib/ChargerConventions.js` - the standard capability id (`evcharger_charging_state`),
  default "unplugged" value (`plugged_out`), the per-device settings override, and the
  `charger_status` "session completed" refinement.
- `lib/PredictionModel.js` - stores events and turns them into the next predicted
  departure/arrival.
- `lib/FallbackKDEModel.js` - the KDE that does the actual prediction.
- `lib/TimeSlots.js` - local time-of-day/weekday helpers.
- `lib/InsightsBackfill.js`, `lib/EdgeDetector.js` - one-time backfill from Homey's own
  Insights history for the bound capability, if any exists, plus the shared
  transition-detection logic used by both the backfill pass and live updates.
- `lib/DailyEnergyModel.js`, `lib/DailyEnergyBackfill.js` - the daily charge-need
  prediction from the charger's cumulative meter, and its one-time Insights seed.
- `test/` - run with `npm test`; `predictionModel.test.js` seeds a synthetic history and
  checks the KDE converges sensibly and that confidence tracks consistency, and
  `dailyEnergyModel.test.js` covers the daily charge-need model.

## Known open items (see the implementation plan for detail)

- `makeCapabilityInstance` reconnect semantics after the charger app restarts, and the
  exact `homey-api`/`compatibility` version pin, should be exercised against a real
  Homey Pro before relying on this day to day.
- `plugged_out` as the universal "unplugged" value for `evcharger_charging_state` is
  confirmed by Homey's own docs' wording and by live data from a real Easee charger, but
  the *complete* authoritative enum (and whether every charger app conforms exactly) 
  isn't published anywhere fetchable - hence the settings override as a safety net
  rather than a hard assumption.
- The `charger_status: "Completed"` refinement is confirmed correct for Easee
  specifically (read directly from their source). It's applied generically to any
  charger exposing a `charger_status` capability, which is a reasonable bet but not
  verified for other brands - if some other app happens to use that same capability id
  with an unrelated meaning where "Completed" means something else, this could
  misbehave for that specific app (falls back to trusting `evcharger_charging_state`
  alone otherwise, so the blast radius is small).
- Icons are all original artwork for this project, drawn to follow Athom's own
  device-icon conventions (from `homey-lib/assets/device/icons`) so they sit
  alongside the built-in set - none of Athom's assets are copied or shipped:
  - `assets/icon.svg` - the app icon: a clock face with a lightning bolt in place
    of its hands (this app predicts the *timing* of charging), drawn from scratch
    rather than reusing Athom's `car-charger` glyph. Solid-black line art, no
    background fill, matching the convention confirmed from real installed apps'
    `icon.svg` files (Tesla, Easee, powerhour): Homey appears to treat this file
    as a themed mask/glyph rather than a literal full-color image - an earlier
    attempt filled a colored background circle and rendered as a solid black dot
    in Homey once deployed.
  - `assets/capability/` - per-capability icons: `time` (plain clock) for the predicted
    times, `minutes` (stopwatch) for the minutes-until values,
    `confidence` (gauge with a needle) for the confidence percentages, and
    `plugged-in` for `car_present` (the same original clock-and-bolt glyph as the
    app icon, reused). All are drawn here rather than reused: Homey ships only two
    clocks, both stylised (a framed wall
    clock and a mantel clock), nothing plain, and nothing gauge-like at all for a
    confidence percentage. They follow the same conventions as Athom's set - 960x960
    viewBox, black stroke-only line art - so they sit alongside it consistently, and
    stay legible down to ~48px. Custom capabilities support an `icon` field; Homey's own
    built-in capabilities instead style themselves with `color` + `uiComponent` and ship
    no per-capability SVG, so there was nothing to reference by name.
  - `assets/images/*.png` and `drivers/ev_charging_predictor/assets/images/*.png` -
    the app icon rasterised in brand green onto a genuinely transparent RGBA
    background (rendered at 4x and downsampled, since thin line art aliases badly at
    75px), matching how real driver/app images float on transparency rather than being
    flat colored rectangles. Regenerated from the original `icon.svg` above.
  - `drivers/ev_charging_predictor/assets/icon.svg` - the same original app icon
    (clock-and-bolt). Note the official CLI template only scaffolds an app-level
    `icon.svg`, and neither Tesla's nor Easee's app ships a driver-level one, so
    Homey may well ignore it; the device tile is driven by the driver's PNGs regardless.

  **Licensing:** every icon and image is original artwork for this project - nothing
  from `homey-lib` or any other app is copied or shipped. They only follow Athom's
  device-icon *style* conventions (960x960 viewBox, black stroke-only line art) for
  visual consistency. Free to publish.

## Supported chargers

Any charger app that declares the standard `evcharger_charging_state` pairs and works
out of the box (about 57% of apps - roughly 20 of the ~35 surveyed). On top of that,
`lib/ChargerProfiles.js` carries brand profiles for chargers that need help:

- **Full history from day one (Insights backfill + false-departure guard): Easee.**
  Its idle-current behaviour was verified on real hardware.
- **Pairs via a vendor capability** (these apps never adopted the standard one):
  Zaptec, Ohme, Mennekes (AMTRON Modbus), go-e, Smappee, evcc, GARO, KEBA, and generic
  OCPP 1.6 chargers.
- **Pairs on the standard capability but gets a guard against a known false-departure
  bug:** Wallbox (`nl.xseth.wallbox`).

Everything but Easee was derived from each app's public source (see the `source` on each
profile) and not yet verified on hardware; they start with no history and learn from live
events. Not yet profiled: ChargeAmps (uses a different capability per model - needs a
small model change) and amina (closed source). If your charger isn't listed and doesn't
declare the standard capability, it won't appear in the picker until a profile adds it.

## Adding another charger

**Pull requests welcome, and they should only ever touch one file:
`lib/ChargerProfiles.js`.** Everything brand-specific is data there; the prediction and
detection logic knows nothing about any vendor.

Why this file has to exist: Homey standardised `evcharger_charging_state` only in
firmware 12.4.5, and nothing forces apps to adopt it. In a survey of 35 real EV charger
apps, **only ~57% declare it** - Zaptec, Ohme, Monta, KEBA, ChargeAmps, Amina, Mennekes,
go-e (oh2th), Smappee, evcc, GARO and several OCPP apps don't. And because Homey Insights
only logs numbers/booleans, the standard enum can never be backfilled, so history has to
come from a numeric capability - where sub-capability names are free-form and the same
survey found **seven** different per-phase conventions (`.p1`, `.L1`, `.l1`, `.phase1`,
`.phase_a`, `.a`, and KEBA's non-sub-capability `measure_current_1`), with Easee using
two of them inside its own app.

A profile can supply any of three things, all optional:

| Field | What it fixes |
| --- | --- |
| `stateCapability` | Lets a charger pair **at all** when its app never adopted `evcharger_charging_state`. Names the vendor capability and which of its values mean unplugged. The standard capability always wins when present. |
| `connectedGuards` | Stops false departures when an app conflates "session finished, cable attached" with "unplugged". |
| `currentSources` | Enables **history backfill**, so the device starts with weeks of real history instead of nothing. |

Two things to know before contributing:

- **Guards are scoped per app id on purpose.** At least three unrelated apps (Easee,
  myenergi, Ohme) expose a capability literally named `charger_status` with three
  completely different value sets. Matching on capability id alone would eventually
  misfire on somebody else's charger.
- **Only add `currentSources` if you have verified it on your own charger.** The
  assumption is a small non-zero current while connected but idle, and a true zero while
  unplugged. Do not assume it holds: under IEC 61851 the contactor is open in both
  states, so many chargers read zero for both, and no app in the survey infers plug state
  from current at all. Easee's 0.05 A appears to be a quirk, not a rule. Getting it wrong
  doesn't fail loudly - the app silently learns *"departure = the moment charging
  stopped"*, which is worse than having no history. The file documents how to check in
  Insights. Leaving it out is always safe.

Unknown chargers degrade predictably: if the standard capability is present they pair and
track presence normally, just with no backfill and no guards. If it isn't, they don't
appear in the picker at all rather than pairing into something that never reports.

`test/chargerProfiles.test.js` covers all of this - Easee's behaviour, safe degradation
for an unknown brand, and the cross-vendor collision cases. Please add a case with your
profile.

## Possible future scope

Generic device/capability binding (presence sensors, GPS trackers, other car
integrations - boolean signals with an invert flag, not just charger enums) was
prototyped and removed to keep the initial scope to EV chargers only. Worth
reconsidering once the charger-based path is proven out.
