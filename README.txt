EV Charging Predictor learns when your car leaves and comes home, and how much energy it needs, all from your EV charger. It runs entirely on your Homey, with no cloud and no account.

Pair it with your existing charger in one step. From then on the app watches when the cable is plugged in and out, and learns your weekly routine. It predicts:

- When the car will leave next, and when it will be back
- How many kWh the car will need tomorrow, with a low/high range

Each prediction comes with a confidence score that rises as your routine becomes clear. Every day the timeline shows how close the last prediction was.

Use the predictions in your own Flows, for example: "If new prediction is calculated, Tesla Model 3 must be ready at X" Or skip a smart-charging plan on days the car barely needs a top-up.

The app never controls your charger. It only predicts, and your own Flows decide what to do with it.

Easee chargers start with real predictions straight away, using the history Homey already keeps. Other chargers start learning from the moment you pair them; give it one to two weeks.

Supported chargers: any charger app that uses Homey's standard charging-state capability, plus Zaptec, Ohme, Mennekes (AMTRON), go-e, Smappee, evcc, GARO, KEBA, Wallbox and generic OCPP 1.6 chargers. Easee is verified on real hardware; the other brands are supported but not yet confirmed, so feedback is very welcome.

Why this app asks for access to your Homey: your charger belongs to another app, and the only way for an app to read another app's device and its history is through the Homey API. The app uses it to read the charger's plug state, current and energy meter. It only reads, and nothing leaves your Homey.
