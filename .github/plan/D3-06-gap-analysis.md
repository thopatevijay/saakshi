---
title: "D3-06 · GIS gap analysis and generated report"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "backend", "frontend", "pillar-1", "model-1-deliverable"]
blocked_by: ["D1-08", "D3-01"]
estimate: "3h"
---

## Context

**Model 1 names this as a required deliverable: "sample gap-analysis report".** It must be
*generated from real data*, not hand-written — that is the difference between a registry that is a
list and a registry that is a planning instrument.

The insight that makes ours different: a gap is not just "no camera here". It is **"no *trusted*
camera here"**. Coverage computed against dead and blind cameras is a lie, which is exactly the
false-assurance problem in `PROJECT.md §1 P2`.

## Scope

- Coverage model per camera: a simple, documented FOV wedge (bearing + range + angle) or radius
  fallback where bearing is unknown — stored in `camera_coverage`
- Intersect coverage with `road_network` in PostGIS → covered vs uncovered road kilometres
- **Trust-weighted coverage**: compute coverage twice — counting all cameras, and counting only
  `trusted` cameras. The delta is the headline finding.
- Gap outputs: uncovered road km by district; junctions with zero trusted coverage; clusters of
  untrusted/dead cameras; departments with the largest trust deficit
- Map overlay reusing the D1-08 map component: covered (trusted) / covered (untrusted) / uncovered
- Report generator → Markdown + PDF, with the numbers, the map, and the method stated

## Acceptance Criteria

- [ ] `camera_coverage` populated for every camera with a documented FOV assumption per camera
- [ ] Covered/uncovered road km computed; totals reconcile against `road_network` length
      (covered + uncovered = total, within a stated tolerance)
- [ ] **Both** all-camera and trusted-only coverage computed, and the delta reported
- [ ] Junctions with zero trusted coverage listed with coordinates
- [ ] Map overlay renders the three states distinctly and performs at statewide zoom
- [ ] Report generated to `docs/gap-analysis-sample.md` **and** PDF, entirely from live data
- [ ] The report states its own method and assumptions, including the crudeness of the FOV model —
      no overclaiming
- [ ] Re-running the generator after a trust change updates the numbers

## Deliverables

- `packages/api/src/services/coverage.ts`
- `npm run report:gap-analysis`
- `docs/gap-analysis-sample.md` + `docs/gap-analysis-sample.pdf` — **Model 1 deliverable**
- Map overlay in `packages/web`

## Validation Gate

```bash
npm run test -w packages/api -- coverage
npm run report:gap-analysis
test -s docs/gap-analysis-sample.md
psql $DATABASE_URL -c "select count(*) from camera_coverage;"   # = camera count
```

- [ ] Km reconciliation within tolerance
- [ ] Trusted-vs-all delta present and non-trivial
- [ ] Report renders; screenshot captured

## Handoff → D4-04, D4-06

The trusted-vs-all coverage delta is one of the strongest single numbers we will show. Put it on a slide.
