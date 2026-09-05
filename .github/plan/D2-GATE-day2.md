---
title: "D2-GATE · Day 2 gate: the core scoring loop works"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "gate"]
blocked_by: ["D2-01","D2-02","D2-03","D2-04","D2-05","D2-06","D2-07","D2-08","D2-09","D2-10"]
estimate: "1h"
---

## Purpose

**Do not start Day 3 until this passes.** Day 3 is differentiators. Differentiators on top of a
broken core score nothing — and the core *is* the graded test case.

## The loop

> Give the system a registration number. It returns that vehicle's sightings across cameras with
> timestamps, locations and evidence crops. Independently, a watchlist vehicle appearing on a live
> feed raises a deduplicated alert with a complete "why" payload within ten seconds.

## Acceptance Criteria

- [ ] Live ANPR running on ≥ 8 cameras; `plate_reads` accumulating with confidences
- [ ] **Measured ANPR precision/recall recorded** (from D2-01) — real numbers, day and night
- [ ] Fuzzy search returns correct ranked candidates for confusable variants of a known plate
- [ ] Trace of a cold-picked plate returns chronologically correct, human-verified sightings
- [ ] Seeded watchlist plate on a live feed → alert in the UI within 10 s, with crop and "why"
- [ ] Dedupe holds under repeat sightings
- [ ] Alert queue passes the three-second verification test
- [ ] CSV + PDF trace export produced and reviewed
- [ ] `npm run typecheck && npm run lint && npm run test` green; `pytest workers -q` green
- [ ] Everything found today logged to `BL-01`

## Validation Gate

```bash
docker compose up -d && npm run db:migrate && npm run sync:catalogue && npm run seed:watchlist
python -m workers.analytics.run --cameras <8 ids> --minutes 10 --anpr &
npm run typecheck && npm run lint && npm run test && pytest workers -q
curl -fsS "localhost:4000/api/v1/trace?plate=<known>" | jq '.sightings|length'
psql $DATABASE_URL -c "select count(*) from alerts;"
```

- [ ] All green from a clean start
- [ ] `docs/screenshots/day2-{trace,alerts}.png` committed
- [ ] A comment stating: plate reads count, measured P/R, alerts raised, dedupe ratio, trace latency p95

## Handoff → Day 3

If ANPR accuracy is materially lower than hoped, say so here in numbers and adjust the deck's claims
**now**, not on Day 4. Honest numbers are a scoring asset; discovering them late is a risk.
