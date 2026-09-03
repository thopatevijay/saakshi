---
title: "D1-06 · Trust score computation, breakdown API, and gap inputs"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "backend", "pillar-1", "differentiator"]
blocked_by: ["D1-05"]
estimate: "2h"
---

## Context

The score must **never be a black box.** Its whole credibility rests on a judge being able to click
a camera and see exactly which signal cost it points. That is also the honest-engineering position:
deterministic and explainable, not a model's opinion.

## Scope

- `trust_score` 0–100 from the D1-05 signals, with per-signal contribution stored in `breakdown jsonb`
- Weights calibrated against the **real observed ranges** from D1-05's handoff comment, not guesses
- Weights live in config, not code, and are documented with rationale
- Classification bands: `trusted (≥70) · degraded (40–69) · untrusted (<40) · dead (unreachable)`
- Trend: score over time per camera (Timescale time_bucket) so degradation is visible
- API: `GET /api/v1/cameras/:id/trust` (current + breakdown + 7-day trend),
  `GET /api/v1/trust/summary` (estate-wide distribution by department/district)

## Acceptance Criteria

- [ ] Score computed for every camera with a health check; nulls handled explicitly, never as zero
- [ ] `breakdown` names every signal, its raw value, its weight, and its point contribution
- [ ] Weight change in config alters scores with **no code change** (test proves it)
- [ ] Bands assigned correctly at the boundaries (69/70, 39/40) — boundary tests present
- [ ] A camera that goes dark drops to `dead` on the next pass and its trend shows the drop
- [ ] Estate summary matches a hand-computed count from SQL (verified, not assumed)
- [ ] `docs/trust-score.md` documents every weight **and why it has that weight**

## Deliverables

- `packages/api/src/services/trust.ts` + `config/trust-weights.json`
- Trust endpoints
- `docs/trust-score.md` completed

## Validation Gate

```bash
npm run test -w packages/api -- trust
curl -fsS localhost:4000/api/v1/trust/summary | jq
curl -fsS localhost:4000/api/v1/cameras/<id>/trust | jq '.breakdown'
psql $DATABASE_URL -c "select count(*) filter (where trust_score>=70) trusted, count(*) filter (where trust_score<40) untrusted from cameras;"
```

- [ ] Breakdown is human-readable and sums to the score
- [ ] Summary counts match the SQL

## Handoff → D1-08, D3-05

The trust band is what colours the map, and untrusted cameras are what the gap analysis flags.
