---
title: "D2-09 · Estate-independent map verification: fixtures so clustering and pins stay tested"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "frontend", "test-case", "model-1-deliverable"]
blocked_by: ["D1-08"]
estimate: "1h"
---

## Context

`D1-GATE` (#14) was closed with ACs 2, 4 and 6 amended, because the Gujarat Sentinel catalogue
publishes exactly two fields per camera — `id` and `name`. No coordinates, no declared specifications,
no district. That was the right call: storing a coordinate nobody published would be inventing
evidence. But it left a hole.

`packages/web/scripts/verify-map.mjs` now fails four checks on every run against the real estate:

```
✗ clustering works at statewide zoom — 0 clusters covering 0 cameras
✗ individual pins at street zoom — 0 pins, 0 clusters
✗ the filter narrows the estate rather than emptying it — the API returns 0 cameras
✗ all three filters came back from the URL into their controls after a full page load
```

All four need coordinates or a `district` the catalogue does not publish. **Today they fail loudly.
The risk is next week, when "those four always fail" becomes the explanation and a genuine
regression in clustering or pin rendering is indistinguishable from the data gap.** The GIS map is
Model 1's headline deliverable; it is the worst place in the product to lose a signal.

The exposure is bounded, not total. `src/lib/registry/geojson.test.ts` already covers the coordinate
path on fixtures — *"needs both coordinates"*, *"emits [lon, lat] — the GeoJSON order"*, *"skips
unplaced cameras rather than drawing them at null island"*, *"copies the API band verbatim and never
recomputes it from the score"* — alongside `basemap-style.test.ts` and `query.test.ts`. The **logic**
is protected estate-independently. Only the **browser render with real coordinates** is not.

`bench-dashboard.mjs` already solves exactly this shape: it seeds 100k rows, measures, and cleans up.

## Scope

- `verify-map.mjs` seeds its own placed fixtures — coordinates, a `district`, a spread of trust
  bands including one never-probed camera — asserts against them, then removes them, leaving the
  database exactly as it found it (including on failure).
- Fixtures are unmistakably fixtures: a reserved `external_id` prefix, never colliding with `cam*`
  or a real import, and never left behind to inflate a later count.
- The four checks above pass on any estate, including one with zero placed cameras.
- The real estate is still asserted alongside the fixtures: the count of cameras *without*
  coordinates must stay correct and they must stay listed in the tray, not dropped.
- Add the standing rule to `.claude/commands/gate.md` and `.claude/commands/start.md`: **an amended
  or waived AC must name the test that still protects the capability; if none exists, the test comes
  first.** One line each.

## Out of scope

- Changing any map, filter or ingest behaviour. This ticket adds no feature and removes none —
  if a source file under `app/(shell)/registry/` or `src/lib/registry/` changes, something is wrong.
- Backfilling coordinates for real cameras from any source. The absence is a finding, and it stays.

## Acceptance Criteria

- [ ] `verify-map.mjs` passes all of its checks on a database whose only real cameras have no
      coordinates — the four listed above included
- [ ] Clustering is asserted with a real number: N fixtures at statewide zoom collapse to fewer
      clusters, and at street zoom render as individual pins, with both counts printed
- [ ] A filter over a fixture attribute narrows the estate to a known non-zero count, and all three
      filters survive a full page reload from the URL
- [ ] Fixtures are removed afterwards — a row count taken before and after the script is identical,
      proven in the output, and still identical when the script fails part way
- [ ] The unplaced-camera assertions still hold: every real camera without coordinates appears in
      the tray, and the "without coordinates" count is unchanged by the fixtures
- [ ] No file under `packages/web/app/(shell)/registry/` or `packages/web/src/lib/registry/` is
      modified — `git diff --stat` in the PR shows scripts and command files only
- [ ] Both command files carry the amended-AC rule

## Validation Gate

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test
node packages/web/scripts/verify-map.mjs <token-file> http://localhost:3100 http://localhost:4000
psql "$DATABASE_URL" -tAc "select count(*) from cameras"   # before and after — identical
```

- [ ] Every check in `verify-map.mjs` green, with the cluster and pin counts in the output
- [ ] Camera row count identical before and after
- [ ] The PR diff touches no registry source file

## Handoff → D2-08, D3-01, D3-06

These inherit the same disjoint-set estate and will each want placed fixtures to test a map overlay
against. State plainly where the fixture helper lives, what it seeds, and how it cleans up.
