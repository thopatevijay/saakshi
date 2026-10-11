---
title: "D4-18 · Place the 30 sandbox cameras from their names, with honest precision"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4","data","demo-critical"]
blocked_by: []
estimate: "2h"
---

## Context
The finale (Phase 1) runs on the sandbox feed. The catalogue gives `{id, name}` only, so all 30 real cameras sit in the "Not on the map" tray while every map pin is synthetic. The names are mostly junctions or places ("04 Paldi Circle", "12 Tri Mandir Adalaj Tollnaka", "30 kheram", "36/37/38 bilimora").

## Scope
Research only. **No application code, and do not import into the user's database.**
1. For each of cam01–cam30 find coordinates from the name: **first** offline (the OSM road network already in Postgres, `road_network`, and the Gujarat OSM extract under `data/`), **then** cross-check with OpenStreetMap Nominatim (≤ 1 request/s, an identifying User-Agent, place names only).
2. Grade precision per camera: `junction` · `road` · `locality` (village/town only) · `not_found`. Record the source(s) and the distance between sources when there are two.
3. Flag ambiguity explicitly (three identical "bilimora", "Rajkot CCTV" = city only). Never invent precision.

## Acceptance Criteria
- [ ] `fixtures/sandbox-coordinates.csv` with header `externalId,name,lat,lon,adapterKind,district`, containing **only** `junction`/`road` precision rows, `adapterKind=hls`
- [ ] `docs/sandbox-coordinates.md`: a table of all 30 cameras with precision, lat/lon (when found), source(s), inter-source distance in metres, and notes; the method; the limits
- [ ] Every `junction`/`road` row agrees between two sources within 500 m, or the disagreement is stated
- [ ] The CSV imports cleanly through `POST /api/v1/cameras/bulk` into a **throwaway** database holding the 30 sandbox cameras: rows update in place (`updated`, not `created`), `endpoints` unchanged; evidence = the import response
- [ ] No coordinate is presented as surveyed: the doc says "placed from the camera name"
