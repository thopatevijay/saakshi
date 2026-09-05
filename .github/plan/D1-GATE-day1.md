---
title: "D1-GATE · Day 1 gate: working vertical slice"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "gate"]
blocked_by: ["D1-02","D1-04","D1-05","D1-06","D1-07","D1-08","D1-09"]
estimate: "1h"
---

## Purpose

**Do not start Day 2 until this passes.** Day 1's goal is depth on one path, not breadth. If the
slice does not work end to end, Day 2 builds on sand.

## The slice

> A real sandbox camera is onboarded from the catalogue, probed for trust, opened through an adapter,
> processed by the analytics worker, and its detections are recorded against that camera and surfaced
> in the registry UI — with the camera's trust breakdown, and the declared-vs-measured comparison
> wherever a declared value exists.

*Amended 5 Sep 2026 — see the Amendment section. The original wording ended "its detections are
visible on the GIS map … showing measured-vs-declared FPS", which presumes catalogue fields the
Sentinel estate does not publish.*

## Acceptance Criteria

- [ ] `docker compose up` + `npm run db:migrate` + `npm run sync:catalogue` from a clean state works
- [ ] Registry holds every catalogued camera; coordinates are stored correctly **when the source
      supplies them**, and their absence is surfaced explicitly rather than filled in
- [ ] Trust scores present for all decodable cameras, with breakdowns
- [ ] The **declared-vs-measured** comparison (fps, resolution, codec) renders in the UI for any
      camera that carries a declared value; where the catalogue declares nothing, the absence is
      reported rather than fabricated
- [ ] Analytics worker running on ≥ 8 cameras, sightings accumulating
- [ ] Map renders on the self-hosted basemap with cameras coloured by the **API trust band**,
      filters compose and survive a reload, the detail drawer shows the full breakdown, and cameras
      without coordinates are listed explicitly rather than dropped
- [ ] All four roles log in with correct permissions
- [ ] `npm run typecheck && npm run lint && npm run test` green across all workspaces
- [ ] `pytest workers -q` green
- [ ] Measured throughput recorded (from D1-09)
- [ ] Every finding so far logged to `BL-01`

## Validation Gate

```bash
# From a clean clone:
docker compose up -d && npm install && npm run db:migrate && npm run sync:catalogue
npm run typecheck && npm run lint && npm run test
pytest workers -q
npm run build -w packages/web
```

- [ ] All commands green from a clean clone
- [ ] Screenshot of the working map committed to `docs/screenshots/day1-slice.png`
- [ ] A comment on this issue stating: cameras onboarded, cameras decodable, trust distribution,
      sightings count, measured throughput

## Handoff → Day 2

If any AC fails, fix it **before** opening a Day 2 ticket. Record the reason for any deferral in `BL-01`.

## Amendment — 5 Sep 2026

Three acceptance criteria presumed catalogue fields that the Gujarat Sentinel estate does not
publish. Verified three ways during the gate run: fetching through the app's own
`defaultFetchCatalogue` returns `entries: 30 · field names: id, name · geospatial fields: NONE`; the
prober prints `—` in its declared-FPS column for all 30 cameras; and
`workers/prober/signals.py:105-112` already documented it.

| AC | Original wording | Why it was amended |
|---|---|---|
| 2 | "…with correct coordinates" | The catalogue supplies no coordinates. The ingest maps `lat`/`lon` when present (`catalogue-sync.ts:240-248, 402`) and D1-08 verified imported coordinates against `ST_X`/`ST_Y` to 1e-6°. There are none to map. |
| 4 | "At least one camera shows a declared-vs-measured FPS divergence in the UI" | No camera declares an FPS, so none can diverge. The feature is implemented API→UI and was demonstrated on `cam30` (declared 25 vs measured 4.85, delta −20.15) with operator-entered values that were reverted immediately after. |
| 6 | "Map renders cameras coloured by trust…" | With no coordinates the map draws 0 pins. Everything not gated on coordinates passed: band agreement on all 30, a paint expression carrying no score threshold, 30 correct tray chips, toggles surviving reload, p95 frame time 39.2 ms. |

**The capability is not reduced — only the assumption that the estate exercises it.** Storing a
coordinate nobody published, or a declared FPS nobody declared, would be inventing evidence, which
this project's claims discipline forbids. The absences are surfaced in the UI instead: *"The registry
holds no coordinates for these cameras. They are measured and scored — the gap is location, not
health."*

Decision by the repository owner, 5 Sep 2026. The three absences carry forward to `D4-08` as stated
limitations, and to `D3-01` / `D3-06`, which inherit the same disjoint-set problem.
