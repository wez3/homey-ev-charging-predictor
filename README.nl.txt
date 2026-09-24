EV Charging Predictor leert wanneer je auto vertrekt en weer thuiskomt, en hoeveel energie hij nodig heeft, allemaal via je laadpaal. De app draait volledig op je Homey, zonder cloud en zonder account.

Koppel de app in één stap aan je bestaande laadpaal. Vanaf dat moment houdt hij bij wanneer de kabel in- en uitgeplugd wordt, en leert hij je weekritme. Hij voorspelt:

- Wanneer de auto de volgende keer vertrekt, en wanneer hij terug is
- Hoeveel kWh de auto morgen nodig heeft, met een onder- en bovengrens

Elke voorspelling heeft een betrouwbaarheidsscore die stijgt naarmate je ritme duidelijker wordt. Elke dag laat de tijdlijn zien hoe dicht de laatste voorspelling erbij zat.

Gebruik de voorspellingen in je eigen Flows, bijvoorbeeld: "Als er een nieuwe voorspelling is berekend, moet de Tesla Model 3 om X klaar zijn." Of sla een slim laadplan over op dagen dat de auto nauwelijks bijgeladen hoeft te worden.

De app bestuurt je laadpaal nooit. Hij voorspelt alleen; jouw eigen Flows bepalen wat je ermee doet.

Easee-laadpalen hebben meteen echte voorspellingen, op basis van de historie die Homey al bijhoudt. Andere laadpalen beginnen te leren vanaf het moment dat je ze koppelt; geef het een à twee weken.

Ondersteunde laadpalen: elke laadpaal-app die de standaard laadstatus van Homey gebruikt, plus Zaptec, Ohme, Mennekes (AMTRON), go-e, Smappee, evcc, GARO, KEBA, Wallbox en generieke OCPP 1.6-laadpalen. Easee is getest op echte hardware; de andere merken worden ondersteund maar zijn nog niet bevestigd, dus feedback is zeer welkom.

Waarom deze app toegang tot je Homey vraagt: je laadpaal hoort bij een andere app, en een app kan het apparaat en de historie van een andere app alleen via de Homey API uitlezen. Deze app gebruikt dat om de stekkerstatus, de stroom en de energiemeter van de laadpaal te lezen. Hij leest alleen, en er verlaat niets je Homey.
