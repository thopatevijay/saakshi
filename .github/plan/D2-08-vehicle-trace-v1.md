---
title: "D2-08 · Vehicle trace v1: identity linking, timeline, map"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "frontend", "pillar-3", "test-case"]
blocked_by: ["D2-04"]
estimate: "4h"
---

## Context

**This is the graded live test case.** The jury hands us a registration number and expects the
vehicle's *complete route with timestamped, location-wise movement history*.

v1 delivers ordered sightings on a map with a timeline. D3-01 upgrades it to road-graph route
reconstruction with observed-vs-inferred segments. Get v1 solid first.

## Scope

- Identity resolution: group sightings into a `vehicle_identity` via the D2-04 matcher
  (`plate_exact` and `plate_fuzzy` link methods, each with a confidence)
- Trace API: `GET /api/v1/trace?plate=<no>&from=&to=&min_confidence=`
  → ordered sightings with camera, location, PTS timestamp, crop, link method, confidence
- Trace UI: map with numbered sighting pins + connecting order, a synchronised timeline scrubber,
  and an evidence strip of crops in chronological order
- Show every sighting's **confidence and how it was linked** — a fuzzy-linked sighting must be
  visually distinct from an exact one
- Export the trace as CSV + PDF (feeds the D4-03 output report)
- Deep link from an alert row ("trace this vehicle") carrying the plate and time window

## Acceptance Criteria

- [ ] Given a plate present on the feeds, the trace returns its sightings **in correct chronological
      order by PTS-derived timestamp**, not by insertion order
- [ ] Fuzzy-linked sightings included, flagged, and filterable by `min_confidence`
- [ ] Map shows ordered pins with camera names; timeline scrubber is synchronised to the map
- [ ] Evidence strip shows crops in chronological order
- [ ] Trace for a plate with **no** sightings returns a clean empty state, not an error
- [ ] Trace for a plate seen at one camera only renders correctly (degenerate case)
- [ ] CSV export contains plate, camera id, camera name, lat, lon, timestamp, confidence, link method
- [ ] PDF export is presentable enough to hand a judge
- [ ] p95 trace latency < 2 s at demo data volume
- [ ] **Rehearsal: run the full test case end to end** — pick a plate cold, trace it, verify every
      returned sighting is genuinely that vehicle by eyeballing the crops. Record the result.

## Deliverables

- `packages/api/src/services/trace.ts` + `identity.ts`
- `packages/web/app/trace/*`
- `docs/screenshots/trace.png`
- Rehearsal result as a comment on this issue

## Validation Gate

```bash
npm run test -w packages/api -- trace
npm run test -w packages/api -- identity
curl -fsS "localhost:4000/api/v1/trace?plate=<known>" | jq '.sightings|length'
npm run build -w packages/web
```

- [ ] Ordering test green (deliberately out-of-order inserts still trace chronologically)
- [ ] Empty and single-sighting cases handled
- [ ] Rehearsal posted, with a human verdict on crop-by-crop correctness

## Handoff → D3-01, D3-02

The ordered sighting list is the input to route reconstruction and to impossible-transition detection.
