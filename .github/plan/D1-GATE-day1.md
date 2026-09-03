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
> processed by the analytics worker, and its detections are visible on the GIS map — with the camera's
> trust breakdown showing measured-vs-declared FPS.

## Acceptance Criteria

- [ ] `docker compose up` + `npm run db:migrate` + `npm run sync:catalogue` from a clean state works
- [ ] Registry holds every catalogued camera with correct coordinates
- [ ] Trust scores present for all decodable cameras, with breakdowns
- [ ] At least one camera shows a **declared-vs-measured FPS divergence** in the UI
- [ ] Analytics worker running on ≥ 8 cameras, sightings accumulating
- [ ] Map renders cameras coloured by trust, filters work, detail drawer shows the breakdown
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
