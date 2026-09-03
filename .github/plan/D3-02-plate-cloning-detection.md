---
title: "D3-02 · Impossible-transition detection (plate cloning / OCR error)"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "backend", "pillar-3", "differentiator", "headline"]
blocked_by: ["D3-01"]
estimate: "2.5h"
---

## Context

**This is the "why has nobody built this before" feature**, and it falls almost free out of D3-01's
travel-time math.

If a plate is read at two cameras separated by a distance the fastest legal route cannot cover in the
elapsed time, then one of two things is true: the OCR misread one of them, or **the plate is
cloned**. Vehicle plate cloning is a widespread, largely undetected crime in India. The system
should not just flag the anomaly — it should say which explanation is more likely.

## Scope

- For every consecutive sighting pair in a trace, compare elapsed time against the OSRM
  minimum feasible travel time (with a configurable speed tolerance for the fastest plausible driving)
- Flag `route_segments.anomaly = 'impossible_transition'` when elapsed < feasible minimum
- **Disambiguation heuristic**, reported with the flag:
  - low OCR confidence on either read, or a small edit distance to a plausible neighbouring plate
    → likely **misread**; surface the candidate alternative
  - high confidence on both reads, grammar-valid, repeated pattern across multiple pairs
    → likely **cloned plate**
- Cloning suspicion escalated as its own alert type (severity configurable)
- Investigation view: side-by-side crops of the two conflicting reads so an officer can judge
- Never assert cloning as fact. Output is *"physically impossible transition; most likely cause: X"*
  with the evidence for that conclusion.

## Acceptance Criteria

- [ ] Synthetic test: two sightings 200 km apart 60 s apart → flagged impossible
- [ ] Synthetic test: two sightings 5 km apart 15 min apart → **not** flagged
- [ ] Speed tolerance is config; changing it changes the boundary with no code change
- [ ] Misread-vs-clone heuristic implemented; both branches covered by tests using real
      low-confidence and high-confidence reads
- [ ] When misread is likely, the candidate alternative plate is surfaced
- [ ] Cloning suspicion raises an alert with side-by-side crop evidence
- [ ] Output language never claims certainty — asserted by a copy test on the rendered strings
- [ ] Run across the whole real sightings table: report how many impossible transitions exist and how
      they were classified. **If the count is implausibly high, that is an OCR-quality finding —
      log it to `BL-01` and investigate before claiming a cloning-detection capability.**

## Deliverables

- `packages/api/src/services/anomaly.ts` + `config/anomaly-policy.json`
- `packages/web` investigation view with side-by-side crops
- `docs/cloning-detection.md` — method, disambiguation heuristic, limitations, and the observed
  real-data counts

## Validation Gate

```bash
npm run test -w packages/api -- anomaly
npm run analyze:anomalies          # whole-table sweep, prints counts by classification
psql $DATABASE_URL -c "select anomaly, count(*) from route_segments group by 1;"
```

- [ ] Both synthetic tests green; both heuristic branches covered
- [ ] Whole-table sweep results posted as a comment with an honest interpretation

## Handoff → D4-04

This is a headline deck slide. Capture a clean screenshot of a real (or clearly-labelled synthetic)
example.
