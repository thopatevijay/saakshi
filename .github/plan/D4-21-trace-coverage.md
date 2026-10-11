---
title: "D4-21 · Trace never says which cameras it could not see"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4","backend","frontend","demo-critical"]
blocked_by: []
estimate: "2h"
---

## Context
A trace searches only plate reads the analytics worker produced, and the worker analyses a configured subset of cameras. An empty or short trace therefore looks identical to "the vehicle wasn't there", which can wrongly rule out a location in an investigation.

## Scope
The trace response and screen state the coverage behind the answer:
- **Analysed** cameras: registry cameras with at least one sighting inside the trace's time window (the only evidence of analysis the data holds; say so).
- **Not analysed**: every other active registry camera, with the count and a sample list.
- A sentence on screen near the summary, e.g. *"Searched the plate reads of 2 cameras analysed in this window. 28 registry cameras were not analysed: absence there proves nothing."*
- Works for empty results too (the most important case).

## Acceptance Criteria
- [ ] `GET /api/v1/trace` returns `coverage.analysedCameras` and `coverage.notAnalysedCameras` (counts + a capped list), defined as above and documented in the route's module note
- [ ] The trace screen shows the sentence for both a found and an empty result (screenshots)
- [ ] Test: a window with sightings on camera A only → A analysed, B not analysed; an empty result still reports coverage
- [ ] The trace export (CSV/PDF) includes the coverage line
- [ ] No change to which sightings a trace returns; trace tests still green; typecheck and lint green
