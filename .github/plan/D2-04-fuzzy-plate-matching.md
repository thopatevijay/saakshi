---
title: "D2-04 · Confusion-aware fuzzy plate index and search"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "pillar-3", "differentiator", "critical"]
blocked_by: ["D2-03"]
estimate: "3h"
---

## Context

**This is the single highest-leverage feature in the project.**

On evaluation day the jury hands us a vehicle registration number. Indian plate OCR reliably
confuses `0/O/D`, `1/I/L`, `8/B`, `5/S`, `2/Z`, `6/G`, `4/A`, `7/T`. **Teams doing exact-string
matching will return zero hits and fail the test case.** We return ranked candidates with confidence.

## Scope

- Weighted edit distance where **confusable substitutions cost less** than arbitrary ones
  (configurable confusion matrix, seeded from the D2-01 error analysis — use the real observed
  confusions, not a guessed list)
- Postgres `pg_trgm` for cheap candidate generation, then exact re-ranking in application code
  (index narrows, code decides)
- Position weighting: state-code and final-digit errors are treated differently from series errors
- Search API: `GET /api/v1/plates/search?q=GJ01AB1234&max_distance=2&from=&to=&camera_ids=`
  → ranked candidates with `match_type` (`exact|fuzzy`), `distance`, `confidence`, sighting refs
- Combine OCR confidence with edit distance into one ranking score, documented
- Performance target: sub-500 ms over the full sightings table at demo scale

## Acceptance Criteria

- [ ] Exact match always ranks first when present
- [ ] Every single-character confusable substitution of a seeded plate is found at distance 1
      (generated test over the whole confusion matrix)
- [ ] A non-confusable single substitution ranks **below** a confusable one (ordering test)
- [ ] Two-character confusions found within `max_distance=2`; ranking remains sensible
- [ ] Truly unrelated plates are **not** returned — a false-positive test asserts precision
- [ ] Time-window and camera filters compose with fuzzy search
- [ ] p95 latency < 500 ms at demo data volume, measured and recorded
- [ ] Confusion matrix is config, not code, and is documented with its empirical source
- [ ] **Dry run of the live test case**: pick a plate we know appears on the feeds, query it, and
      confirm the sightings returned are correct — recorded as a comment

## Deliverables

- `packages/api/src/services/plate-search.ts` + `config/plate-confusions.json`
- `docs/fuzzy-matching.md` — the algorithm, the confusion matrix, its empirical basis, and the
  measured precision/recall of the *matcher* (distinct from OCR accuracy)

## Validation Gate

```bash
npm run test -w packages/api -- plate-search
curl -fsS "localhost:4000/api/v1/plates/search?q=<known-plate>&max_distance=2" | jq '.[0:5]'
npm run bench:plate-search    # prints p50/p95
```

- [ ] Confusion-matrix generated test suite fully green
- [ ] False-positive precision test green
- [ ] p95 recorded and under target
- [ ] Live-test-case dry run posted as a comment

## Handoff → D2-06, D2-08, D3-02

Alerting, trace, and impossible-transition detection all call this service. Publish the response shape.
