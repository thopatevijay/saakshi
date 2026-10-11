# Sandbox camera coordinates

The sandbox catalogue gives each of the 30 cameras an id and a name, and nothing else. This page
records where each camera can be put on the map **from its name alone**.

> **Every coordinate here was placed from the camera name, not surveyed.** Nobody has stood at
> these cameras, and the catalogue holds no location. A pin is "the mapped place this name most
> plausibly refers to", never "where the camera is mounted".

Import file: [`fixtures/sandbox-coordinates.csv`](../fixtures/sandbox-coordinates.csv). It holds
**27 of the 30** cameras. Each row's `address` column states its precision in words, and the app
shows that text in the camera panel, so the grade travels with the pin. The 3 `not_found` cameras
stay in the "Not on the map" tray.

## Precision grades

| Grade | Meaning | Count | Cameras |
|---|---|---:|---|
| `exact` | Google Maps shows the specific named junction, gate, bridge, building or campus. Uncertainty is that feature's own size: tens of metres for a junction, up to about 1.5 km along a bridge. | 9 | cam01, cam04, cam05, cam08, cam12, cam13, cam17, cam19, cam21 |
| `approximate` | Only a neighbourhood, village, town, city centre or road is identified, or the name had to be interpreted. Uncertainty is up to the size of that place: hundreds of metres to several km. | 15 | cam03, cam06, cam07, cam09, cam10, cam11, cam15, cam16, cam18, cam20, cam22, cam24, cam25, cam26, cam30 |
| `shared` | cam27, cam28 and cam29 are all named "bilimora". They get one Bilimora town-centre point; their pins sit on top of each other. No offsets were invented. | 3 | cam27, cam28, cam29 |
| `not_found` | No place on Google Maps (or OpenStreetMap) matches the name well enough. Left blank, not guessed. | 3 | cam02, cam14, cam23 |

## All 30 cameras

**Source:** **G** = Google Maps search (11 Oct 2026; the pin is the place's own coordinate from the
result, not the map viewport). **O** = the OpenStreetMap candidate recorded in the earlier OSM-only
pass (local extract, `road_network`, Nominatim). "G–O" is the distance in metres between the two
where both exist; above 500 m it is in bold.

| Camera | Name (catalogue) | Grade | Lat, lon | Source | G–O (m) | Notes |
|---|---|---|---|---|---:|---|
| cam01 | 01 Chiman bhai Bridge | `exact` | 23.0695867, 72.5876512 | G; O | 101 | Google: "Chimanbhai Patel Bridge". OSM: "Chimanbhai patel Flyover". The span is about 1.5 km; the camera could be anywhere on it. |
| cam02 | 02 Janpath | `not_found` | | G; O | | Google returns Janpath Complex, Janpath Apartment, Janpath Society and hotels spread across Ahmedabad and beyond; no Janpath junction. One word is not enough to choose. |
| cam03 | 03 O.N.G.C. Office | `approximate` | 23.1019798, 72.5880784 | G | | "ONGC Ahmedabad Asset – Avani Bhavan", Chandkheda. ONGC has offices in many cities; Ahmedabad is inferred from the neighbouring cameras (Visat Circle is 450 m away). OSM had no ONGC office in Ahmedabad. |
| cam04 | 04 Paldi Circle | `exact` | 23.0142067, 72.5649987 | G; O | 154 | Google has "Paldi Char Rasta" (no "Paldi Circle"); circle and char rasta are read as the same junction. O is the Paldi suburb node. |
| cam05 | 05 Visat teen Rasta | `exact` | 23.0982308, 72.5883014 | G | | Google: "Visat Circle" (a second "Visat Circle" listing is 138 m away). OSM had no Visat junction. "Visat Circle Ahmedabad" as a single query resolves to SH41 near Mahesana, 60 km away; the listing was taken instead. |
| cam06 | 06 Timbavadi gate-Junagadh | `approximate` | 21.5044881, 70.4335212 | G; O | 131 | Timbavadi neighbourhood. Neither source maps a "Timbavadi gate". |
| cam07 | 07 hero-showroom-gir-somnath | `approximate` | 20.9258663, 70.3540973 | G | | "Jagdish Automobiles – Hero MotoCorp", Veraval (the district headquarters). Other Hero dealers exist in the district; this one is a choice. |
| cam08 | 08 majewadi-gate-junagadh | `exact` | 21.5354573, 70.4600778 | G; O | 8 | Google: "Majevadi Gate". OSM: "Majevdi Gate". |
| cam09 | 09 new-bypass-near-by-circle-junagadh-2 | `approximate` | 21.5656929, 70.4101728 | G | | Google's "Junagadh Bypass" pin. The bypass is about 20 km long and no circle is named. |
| cam10 | 10 char-chowk-road-2-junagadh | `approximate` | 21.5222203, 70.4579436 | G | | Junagadh city centre. Google's only "Char Chowk" is in Ankolvadi, Gir Somnath (about 55 km away), not Junagadh, so it was not used. |
| cam11 | 11 dolatpara-junagadh | `approximate` | 21.5538445, 70.4691218 | G; O | **639** | Dolatpara neighbourhood. The two sources pick different points inside the same area. |
| cam12 | 12 Tri Mandir Adalaj Tollnaka | `exact` | 23.1867852, 72.5597838 | G; O | 57 | Google: "Toll plaza adalaj". OSM's nearest toll booth agrees (57 m). Trimandir Adalaj itself is 1558 m away; the name's "Tollnaka" decides. |
| cam13 | 13 CN Vidhyalaya | `exact` | 23.0214064, 72.5519863 | G; O | 396 | Google: "Sheth C N Vidyalaya" (another listing, "Seth C N Vidhyalay", is 235 m from O). The campus is about 300 m across. |
| cam14 | 14 Delight RLVD | `not_found` | | G; O | | RLVD = red-light violation detection, so a signalised junction. Google returns only shops and restaurants named Delight across Ahmedabad; no Delight junction. |
| cam15 | 15 Suvidha park | `approximate` | 23.0147239, 72.5592038 | G; O | 6 | Interpreted as "Suvidha Cross Road", Paldi, which is near cam04 and cam13. At least four "Suvidha Park" housing societies exist in Ahmedabad, 4 to 14 km from this junction; the junction was chosen because a camera is more likely at a junction. |
| cam16 | 16 Visat P2 | `approximate` | 23.0982308, 72.5883014 | G | | Same point as cam05. "P2" is not a place. |
| cam17 | 17 Rajkot Bus Port CCTV | `exact` | 22.2910217, 70.8021165 | G; O | 7 | Google: "Rajkot Central Bus Station – Bus port". This settles the earlier OSM ambiguity: the Rajkot New Bus Station candidate is 589 m away and was not used. |
| cam18 | 18 Rajkot CCTV | `approximate` | 22.3038945, 70.8021599 | G | | Rajkot city centre. The name gives the city only. |
| cam19 | 19 KHAPARIA GRAM PANCHAYAT , TALUKA GANDEVI, DISTRICT NAVSARI | `exact` | 20.8639533, 73.0498184 | G; O | 108 | Google: "Gram Panchayat Khaparia". O is the Khapariya village node. |
| cam20 | 20 Mohanpura | `approximate` | 23.8479874, 73.027983 | G | | **Low confidence.** Google's one Gujarat "Mohanpura" (PIN 383430, north-east Gujarat). The name is common: a "Mohanpur" (PIN 383305) also exists in Gujarat, and an unqualified search returns Madhya Pradesh. The camera gives no district. |
| cam21 | 23 Patan Dethali Char Rasta | `exact` | 23.9167434, 72.3611879 | G; O | 17 | Google: "Dethali Char Rasta, Siddhpur". OSM: "Dethali Circle". |
| cam22 | 28 BK Mervada tran Rasta | `approximate` | 24.1438623, 72.4805487 | G | | Merwada village near Palanpur. "BK" is read as Banaskantha, and the PIN (385001) is Palanpur's. The "tran rasta" junction is not mapped; the pin is the village. |
| cam23 | 30 kheram | `not_found` | | G; O | | Google's nearest matches are Kherem (Arunachal Pradesh) and unrelated Gujarat villages (Khaar, Kheradi). Not guessed. |
| cam24 | 33 dehgam | `approximate` | 23.1637196, 72.810245 | G; O | | Dahegam town centre. O identified the same town without a recorded point. |
| cam25 | 34 dhanori | `approximate` | 20.7505537, 72.9507926 | G; O | **12420** | Google's "Dhanori" (PIN 396110) is 12.4 km from OSM's Dhanori near Gandevi (Civil Hospital Dhanori). Both are in the Navsari area; Google's was used. Treat the village as uncertain. |
| cam26 | 35 TANKAL | `approximate` | 20.8528538, 73.1320101 | G; O | **872** | Tankal village, Chikhli taluka. O was the village's health centre, not its centre. |
| cam27 | 36 bilimora | `shared` | 20.7702311, 72.9823779 | G; O | **1397** | Bilimora town centre. O is a different point in the same town. |
| cam28 | 37 bilimora | `shared` | 20.7702311, 72.9823779 | G | | Same point as cam27: identical names. |
| cam29 | 38 bilimora | `shared` | 20.7702311, 72.9823779 | G | | Same point as cam27: identical names. |
| cam30 | Gandhidham Rambaugh p2 | `approximate` | 23.0753822, 70.0907139 | G; O | 14 | Google: "Rambaug Rd", Adipur, Gandhidham. Agrees with OSM's "Rambaug" point (14 m); Rambagh Hospital is 943 m away. "p2" is not a place. |

## Google–OpenStreetMap disagreements over 500 m

| Camera | Distance | Why | Effect |
|---|---:|---|---|
| cam25 | 12,420 m | Two different villages named Dhanori | The pin may be in the wrong village |
| cam27 (cam28, cam29) | 1,397 m | Different points in the same town | Town-level either way |
| cam26 | 872 m | OSM point was the village health centre | Village-level either way |
| cam11 | 639 m | Different points in the same neighbourhood | Neighbourhood-level either way |

Every `exact` row agrees with OpenStreetMap within 400 m where OSM has the feature (cam05 has no OSM
feature to compare).

## Method

1. **Google Maps, one search per name** in a browser, with the camera's town or district appended
   (for example "Majevadi Gate Junagadh", "Dethali Char Rasta Patan"). The pin is the place's own
   coordinate from the result (the `!3d…!4d…` pair of the place link), not the map viewport.
   Spelling variants were tried where the first search missed (Paldi Circle / Paldi Char Rasta,
   Mervada / Merwada, Dehgam / Dahegam).
2. **Grade** by the narrowest thing the result certainly identifies: a named junction, gate,
   building or campus is `exact`; anything coarser or interpreted is `approximate`.
3. **Cross-check** against the earlier OpenStreetMap pass and record the distance.
4. **Write the CSV** with every placed camera. The names are the catalogue's own, including the
   number prefix, so an import changes location, district and address and leaves the name alone.

## Limits

- **A named place is not a camera position.** An `exact` pin is the junction or building; the
  camera may be on any arm of it, and its facing direction is unknown.
- **Name readings are interpretations.** "Paldi Circle" as Paldi Char Rasta, "O.N.G.C. Office" as
  Avani Bhavan, "Suvidha park" as Suvidha Cross Road, and "BK" as Banaskantha are our readings. Each
  is written down above, and in the row's `address`, so it can be challenged.
- **The city is sometimes inferred.** cam02, cam03, cam14 and cam15 do not name a city; Ahmedabad
  comes from the neighbouring cameras.
- **cam20 and cam25 are the weakest pins.** Both are common village names with more than one candidate.
- The fix is a location from the camera owner. One row in the CSV per camera would replace all of
  this. A single camera can also be corrected in the app's Edit dialog.

## Import

The CSV uses the existing bulk-import path, `POST /api/v1/cameras/bulk` (multipart, CSV). Rows match
on `(department_id, external_id)`, so the 27 rows update the existing sandbox cameras in place.
The sandbox cameras' `endpoints` are already `{}`; the import resets that field to `{}`, so it does not change.

Checked on a throwaway database (11 Oct 2026) holding a copy of the 30 sandbox rows:
`received 27, imported 27, created 0, updated 27, rejected []`. Names and endpoints were unchanged
(md5 of external id + name + endpoints identical before and after, 30 rows); 27 rows have a
location and an address, at 24 distinct points (cam27–29 share one, and cam16 shares cam05's).
