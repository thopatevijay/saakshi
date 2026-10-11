# Sandbox camera coordinates

The sandbox catalogue gives each of the 30 cameras an id and a name, and nothing else. This page
records where each camera can be put on the map **from its name alone**.

> **Every coordinate here was placed from the camera name, not surveyed.** Nobody has stood at
> these cameras, and the catalogue holds no location. A pin is "the OpenStreetMap feature this name
> most plausibly refers to", never "where the camera is mounted".

Import file: [`fixtures/sandbox-coordinates.csv`](../fixtures/sandbox-coordinates.csv). It holds
**4 of the 30** cameras: only rows graded `junction` or `road` whose candidate locations agree within
500 m. Every other camera stays in the "Not on the map" tray, deliberately.

## Precision grades

| Grade | Meaning | In the CSV? |
|---|---|---|
| `junction` | The name resolves to one mapped point: a named junction, circle or gate. Uncertainty is the junction's own size, tens of metres. | Yes, if the sources agree within 500 m |
| `road` | The name resolves to a named road, bridge, campus or stretch, but not to a point on it. Uncertainty is up to the length of the feature, a few hundred metres to about 1 km. | Yes, if the sources agree within 500 m |
| `locality` | Only a village, town or neighbourhood can be identified. | **No** |
| `not_found` | Nothing in OSM matches the name, or the name is too generic to pick one place. | **No** |

| Grade | Count | Cameras |
|---|---:|---|
| `junction` | 2 | cam08, cam21 |
| `road` | 4 | cam01, cam13 (placed); cam12, cam17 (left out: candidates disagree by more than 500 m) |
| `locality` | 14 | cam04, cam06, cam09, cam10, cam11, cam18, cam19, cam24, cam25, cam26, cam27, cam28, cam29, cam30 |
| `not_found` | 10 | cam02, cam03, cam05, cam07, cam14, cam15, cam16, cam20, cam22, cam23 |

## All 30 cameras

Sources: **X** = local OSM extract `data/gujarat-latest.osm.pbf` (named features exported with
`osmium`), **R** = the `road_network` table, **N** = OpenStreetMap Nominatim (queried 11 Oct 2026).
"Dist" is the distance in metres between the two locations being compared.

| Camera | Name (catalogue) | Grade | Lat, lon | Source(s) | Dist (m) | Notes |
|---|---|---|---|---|---:|---|
| cam01 | 01 Chiman bhai Bridge | `road` | 23.070259, 72.588310 | X way 37722606; N same way; R | X-N 86; X-R 123 | "Chimanbhai patel Flyover" (SH41, `bridge=yes`) between Ranip and Sabarmati, Ahmedabad. Pin is the centroid of the bridge span; the flyover is about 1.5 km long, so the camera could be anywhere along it. Name match is close but not exact ("Bridge" vs "Flyover"). |
| cam02 | 02 Janpath | `not_found` | | X, N | | Only hotels named Janpath on SH41 in Mahesana district, and Janpath in New Delhi. Nothing in Ahmedabad. |
| cam03 | 03 O.N.G.C. Office | `not_found` | | X, N | | No ONGC office mapped in Ahmedabad. ONGC features exist in Chandkheda (a bus depot), Mahesana, Surat, Vadodara and Kalol; the name does not say which. |
| cam04 | 04 Paldi Circle | `locality` | | X, N | | Only the Paldi suburb node (23.01455, 72.56354). No feature named Paldi Circle or Paldi Char Rasta. Not placed. |
| cam05 | 05 Visat teen Rasta | `not_found` | | X, R, N | | No feature named Visat as a junction or road. Only an apartment block and a hospital elsewhere. |
| cam06 | 06 Timbavadi gate-Junagadh | `locality` | | X, N | 189 | Timbavadi neighbourhood (21.50331, 70.43350) and Timbavadi bus stop (21.50268, 70.43520) agree, but no "Timbavadi gate" is mapped. Neighbourhood only; not placed. |
| cam07 | 07 hero-showroom-gir-somnath | `not_found` | | X, N | | No Hero showroom mapped in Gir Somnath district. The district alone is not a location. |
| cam08 | 08 majewadi-gate-junagadh | `junction` | 21.535443, 70.460000 | X node 648272854; N same node; R | X-N 0 | "Majevdi Gate", a historic city gate on Mahatma Gandhi Road, Junagadh. The road network has Mahatma Gandhi Road through the same point (0 m). The two lookups return the same OSM node, so the agreement checks the name match, not the position. A separate village "Majevadi" lies 8 km north; the camera name says gate. |
| cam09 | 09 new-bypass-near-by-circle-junagadh-2 | `locality` | | X | | Junagadh Bypass is mapped (NH trunk, about 20 km). "Near by circle" names no circle. Junagadh city only. |
| cam10 | 10 char-chowk-road-2-junagadh | `locality` | | X, N | | No "Char Chowk" in Junagadh. Junagadh has many named chowks (Kalwa, Azad, Gandhi, Circle Chowk), none matching. City only. |
| cam11 | 11 dolatpara-junagadh | `locality` | | X, N | | Dolatpara suburb (21.55876, 70.46592). Area only. |
| cam12 | 12 Tri Mandir Adalaj Tollnaka | `road` | | X, N | **1507** | Two candidates disagree: Dadabhagwan Trimandir, Adalaj (23.17848, 72.57213; X and N agree) and the nearest mapped toll booth (23.18653, 72.56027). The name points at a toll plaza near the temple, but the nearest toll booth is 1.5 km from it. **Left out.** |
| cam13 | 13 CN Vidhyalaya | `road` | 23.019348, 72.548823 | X way 336335115; N same way | X-N 40 | Sheth C N Vidyalaya (Sheth Chimanlal Nagindas Vidyavihar), Ambawadi, Ahmedabad. Pin is the campus centroid; the campus is about 300 m across and the camera is likely on a boundary road. |
| cam14 | 14 Delight RLVD | `not_found` | | X, N | | RLVD = red-light violation detection, so a signalised junction. Nothing named Delight in Ahmedabad or Gandhinagar. |
| cam15 | 15 Suvidha park | `not_found` | | X, N | | No "Suvidha Park" mapped. There is a "Suvidha Crossroads" junction in Paldi (23.01468, 72.55917), 1.2 km from cam13 and 450 m from Paldi. It is a plausible match on one word, which is a guess, so **not placed**. |
| cam16 | 16 Visat P2 | `not_found` | | X, N | | As cam05; "P2" is not a place. |
| cam17 | 17 Rajkot Bus Port CCTV | `road` | | X, N, R | **589** | Two features on Dhebar Road, Rajkot, could be the "bus port": GSRTC Central Bus Station (22.29105, 70.80218) and Rajkot New Bus Station (22.29576, 70.79956). The name does not decide between them. **Left out.** |
| cam18 | 18 Rajkot CCTV | `locality` | | | | City only. |
| cam19 | 19 KHAPARIA GRAM PANCHAYAT , TALUKA GANDEVI, DISTRICT NAVSARI | `locality` | | X, N | 0 | Khapariya village, Gandevi taluka (20.86340, 73.04896). X and N return the same node. Village only. |
| cam20 | 20 Mohanpura | `not_found` | | X, N | | Not in the Gujarat extract; Nominatim returns only Madhya Pradesh villages. A common village name; no district given. |
| cam21 | 23 Patan Dethali Char Rasta | `junction` | 23.916598, 72.361154 | X way 225384273; N same way; R | X-N 0; X-R 14 | "Dethali Circle" (દેથલી ચોકડી), a roundabout on SH41 at Siddhpur, Patan district. The two lookups return the same OSM way. A different village called Dethali exists in Becharaji taluka, Mahesana (23.47739, 72.11063), but the name says Patan and "char rasta", and only the Siddhpur feature is a junction. |
| cam22 | 28 BK Mervada tran Rasta | `not_found` | | X, N | | "BK" is read as Banaskantha. No Mervada village or junction is mapped there. |
| cam23 | 30 kheram | `not_found` | | X, N | | No Gujarat match (Kheralu is a different name; Nominatim's only Kheram is in Jammu and Kashmir). |
| cam24 | 33 dehgam | `locality` | | X, N | | Dehgam town, Gandhinagar district. Town only. |
| cam25 | 34 dhanori | `locality` | | X, N | 1639 | Dhanori, Gandevi taluka: Civil Hospital Dhanori (20.83886, 73.02396) and a fenced area named Dhanori (20.83472, 73.03910), 1.6 km apart. Village only. |
| cam26 | 35 TANKAL | `locality` | | X, N | | Tankal, Chikhli taluka, Navsari (PHC at 20.86059, 73.13062). Village only. |
| cam27 | 36 bilimora | `locality` | | X, N | | Bilimora town (20.76717, 72.96935). |
| cam28 | 37 bilimora | `locality` | | X, N | | Same name as cam27. Three cameras cannot be told apart from their names. |
| cam29 | 38 bilimora | `locality` | | X, N | | Same name as cam27. |
| cam30 | Gandhidham Rambaugh p2 | `locality` | | X, N | **929** | Two features: Rambagh Hospital, Gandhidham (23.07550, 70.09993) and a services point named Rambaug (23.07540, 70.09085), 929 m apart. "p2" is not a place. Area only. |

## Disagreements over 500 m

| Camera | Candidates | Distance | What we did |
|---|---|---:|---|
| cam12 | Trimandir Adalaj vs the nearest toll booth | 1507 m | Left out |
| cam17 | GSRTC Central Bus Station vs Rajkot New Bus Station | 589 m | Left out |
| cam30 | Rambagh Hospital vs Rambaug services point | 929 m | Graded `locality`, left out |
| cam25 | Civil Hospital Dhanori vs Dhanori area | 1639 m | `locality` either way, left out |

No row in the CSV has a disagreement: the four placed rows agree within 86 m (X-N) and 123 m (X-R).

## Method

1. **Offline first.** `osmium tags-filter data/gujarat-latest.osm.pbf nwr/name nwr/name:en` then
   `osmium export -f geojsonseq` gives 154,060 named features. Each camera name was searched with
   regexes covering spelling variants (Majewadi/Majevadi/Majevdi, Vidhyalaya/Vidyalaya,
   Rambaug/Rambagh, Char Rasta/Circle/Chokdi), limited to the district where the name gives one.
   Unnamed toll booths were pulled separately (`barrier=toll_booth`).
2. **Road network.** Each candidate was checked against `road_network` for the nearest mapped road,
   and road names were searched directly.
3. **Nominatim.** Place names only (for example "Majevdi Gate, Junagadh"), `countrycodes=in`, one
   request every 1.2 s, User-Agent `saakshi-finale-research/1.0`. 49 queries in all.
4. **Grade.** One of the four grades above, chosen by the narrowest thing the name *certainly*
   identifies. When two features could match, the distance between them is recorded, and above
   500 m the camera is left out.
5. **Write the CSV** with only the agreeing `junction`/`road` rows. The names are the catalogue's own,
   including the number prefix, so an import changes the location and district and leaves the name alone.

## Limits

- **The sources are not independent.** The local extract, `road_network` and Nominatim all come from
  OpenStreetMap. When two of them agree, the name has been matched to the same feature by two
  different lookups (our regex search and Nominatim's ranking). That is not a second survey. For
  cam08, cam13 and cam21 both lookups return the same OSM object, so the "distance" is 0 or tiny by
  construction.
- **A named feature is not a camera position.** A junction pin can be tens of metres off, and a road
  or campus pin hundreds of metres off. The cameras' facing direction is unknown.
- **OSM coverage is uneven.** Small-town junctions such as Visat or Delight may exist on the ground
  and simply not be mapped. `not_found` means "not found in OSM", not "does not exist".
- **Name readings are interpretations.** "BK" as Banaskantha, and "Chiman bhai Bridge" as the
  Chimanbhai Patel Flyover, are our readings. Each one is written down in the table above so it can
  be challenged.
- The fix is a location from the camera owner. One row in the CSV per camera would replace all of
  this.

## Import

The CSV uses the existing bulk-import path, `POST /api/v1/cameras/bulk` (multipart, CSV). Rows match
on `(department_id, external_id)`, so the 4 rows update the existing sandbox cameras in place.
Columns that are not in the file reset to their defaults (`cameraType=ip`, `mount=static`,
`geometryClass=unclassified`, `endpoints={}`), and those match how catalogue sync created the
sandbox cameras.
