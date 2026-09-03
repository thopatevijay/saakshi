---
title: "D3-01 · Route reconstruction on the road graph: observed vs inferred"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "backend", "pillar-3", "differentiator", "test-case"]
blocked_by: ["D2-08"]
estimate: "4h"
---

## Context

The test case asks for the *"complete route traversed by the designated vehicle"*. Sightings are
sparse dots. Most teams will show the dots and call it a route.

We produce a **continuous route that explicitly distinguishes what we observed from what we
inferred.** Saying what we do not know is the entire point — an evidentiary system that blurs the
two is worse than useless.

## Scope

- Import the OSM Gujarat extract into `road_network` (PostGIS) and stand up OSRM for travel times
- Between consecutive sightings, snap to the road network and compute the most plausible path
  (OSRM route) plus its expected travel time
- Classify each segment: `observed` (sighting → sighting at the same camera pair with corroboration)
  vs `inferred` (path between two sightings, no direct evidence in between)
- Per-segment `inferred_confidence` from: elapsed-vs-expected travel-time ratio, path uniqueness
  (are there plausible alternatives?), and endpoint sighting confidences
- Persist to `routes` + `route_segments`; cache by (identity, window, params)
- Render: **solid line for observed, dashed for inferred**, with per-segment confidence on hover.
  Legend states the distinction in plain language.
- Route summary: total distance, elapsed time, observed vs inferred kilometre split, camera count

## Out of scope

- Impossible-transition flagging (D3-02) — it consumes this ticket's travel-time math

## Acceptance Criteria

- [ ] OSM extract imported; `road_network` populated with a GiST index; import is documented and reproducible
- [ ] OSRM responds to a route query between two real camera locations with a sane duration
- [ ] Route built for a traced plate with segments correctly classified observed vs inferred
- [ ] **The UI makes the distinction unmistakable** — a reviewer who has never seen the app can tell
      which parts are evidence and which are inference
- [ ] `inferred_confidence` computed by a documented formula; extremes behave sensibly
      (near-instant transition → low confidence; plausible timing → high)
- [ ] Two consecutive sightings at the *same* camera do not produce a spurious segment
- [ ] Route summary numbers agree with a hand check on a small case
- [ ] p95 route build < 3 s for a 20-sighting trace
- [ ] Cache hit on repeat request; cache invalidated when new sightings arrive

## Deliverables

- `packages/api/src/services/route.ts`
- `scripts/import-osm.sh` + `docs/road-network-setup.md`
- `packages/web` route layer with the observed/inferred legend
- `docs/route-reconstruction.md` — method, confidence formula, and its limitations

## Validation Gate

```bash
./scripts/import-osm.sh
psql $DATABASE_URL -c "select count(*) from road_network;"
curl -fsS "http://localhost:5000/route/v1/driving/72.6,23.2;72.65,23.25?overview=false" | jq '.routes[0].duration'
npm run test -w packages/api -- route
curl -fsS "localhost:4000/api/v1/trace?plate=<known>&reconstruct=true" | jq '.route.segments|map(.observed)'
```

- [ ] Segment classification array shows a realistic mix, not all-true or all-false
- [ ] Same-camera and single-sighting edge cases pass
- [ ] Screenshot of the observed/inferred rendering committed

## Handoff → D3-02, D4-03

The travel-time model here is exactly what D3-02 inverts to detect impossible transitions.
