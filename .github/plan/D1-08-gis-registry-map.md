---
title: "D1-08 · GIS registry map with trust overlay"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "frontend", "pillar-1", "model-1-deliverable"]
blocked_by: ["D1-02", "D1-06", "D1-07"]
estimate: "3h"
---

## Context

**Model 1's headline deliverable: "working registry portal with GIS map view".** It is also the
first thing a judge sees, so it carries disproportionate weight on the "platform maturity" score.

Basemap is **self-hosted PMTiles** — no external tile API. That is deliberate: the console must work
on an isolated police network, and it removes a vendor dependency. Say so in the demo.

## Scope

- MapLibre GL + local `gujarat.pmtiles` served by the app (document how the extract was produced)
- Camera pins coloured by **trust band**, clustered at low zoom
- Layer toggles: department · camera type (analog/IP) · mount (static/mobile) · adapter kind ·
  status · trust band
- Filter panel bound to the D1-02 query contract; filters reflected in the URL (shareable state)
- Camera detail drawer: metadata, latest health, **trust breakdown**, retention days, endpoints,
  live-preview button (wired in D3-06)
- Bulk import and manual-add entry points (Model 1's three onboarding paths, visible in the UI)
- Export button → CSV/JSON (Model 1 "sample metadata dataset")

## Acceptance Criteria

- [ ] All catalogued cameras render at correct coordinates; clustering works to statewide zoom
- [ ] Basemap loads **entirely from the local PMTiles file** — verified with the network tab showing
      zero external tile requests
- [ ] Every layer toggle and filter works, composes with the others, and survives a page reload
      via URL state
- [ ] Trust colouring matches the API's band exactly
- [ ] Detail drawer shows the full trust breakdown, not just the score
- [ ] Bulk import from the UI succeeds with the 50-row fixture and shows the row-level error report
      for the invalid fixture
- [ ] Export downloads a valid CSV that re-imports cleanly (round-trip test)
- [ ] Map interaction stays smooth at the full estate size (no visible jank when panning)

## Deliverables

- `packages/web/app/registry/*`
- `data/gujarat.pmtiles` (gitignored) + `docs/basemap-setup.md` on reproducing the extract
- Screenshots into `docs/screenshots/` for the deck

## Validation Gate

```bash
npm run build -w packages/web
npm run test -w packages/web -- registry
```

- [ ] Manual: DevTools network tab shows no external tile domain
- [ ] Manual: CSV export → re-import round trip produces zero duplicates
- [ ] Screenshots captured for the deck

## Handoff → D3-05, D3-06

The map component must accept an overlay layer prop — gap analysis and route rendering both reuse it.
