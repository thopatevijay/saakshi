---
title: "D2-10 · Wire plate normalisation into the write path so a plate that alerts is also traceable"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "pillar-3", "bug"]
blocked_by: ["D2-01", "D2-03", "D2-08"]
estimate: "1h"
---

## Context

`D2-GATE` (#23) failed on this and nothing else. Measured on a clean-state run with a 10-minute live
ANPR pass over 8 cameras:

```
select count(*), count(normalized_text) from plate_reads;   ->   18 |  0
GET /api/v1/trace?plate=GJ3266416   ->   { sightings: 0, emptyReason: "no_matching_plate" }
```

`GJ3266416` **raised an alert in that same run, eighteen minutes earlier.** The loop the day exists
to prove — *"give the system a registration number, it returns that vehicle's sightings across
cameras"* — is broken in half.

Three tickets, each correct in isolation, and the column falls between them:

| where | what it does |
|---|---|
| `workers/analytics/anpr/engine.py:344` | emits `"normalizedText": None`, deferring to D2-03 |
| `packages/api/src/consumers/sightings.ts:276` | stores that null, with a comment restating the deferral |
| D2-03's handoff | *"Wiring the worker to actually call it is **not in D2-03's scope and no ticket currently owns it**."* |
| `packages/api/src/services/trace.ts:442` | `where pr.normalized_text in (...)` — never matches live data |

**The alert path is unaffected only because it computes the value instead of reading it** —
`packages/api/src/services/alerts.ts:576` calls `evaluatePlateRead(candidate.rawText, …)` at
correlation time. Two consumers of one concept: one computes it, one reads a column nobody fills.
That asymmetry is the whole defect.

**Why 772 green tests did not catch it.** D2-08's trace tests set `normalized_text` in their own
fixtures, so they exercise the query and never the write path.

## Scope

- Populate `plate_reads.normalized_text` on the write path, from `evaluatePlateRead` in
  `@saakshi/shared`, so the stored value is the same one the alert path computes.
- **Preserve D2-01's deliberate three-way distinction**, which is a trust signal, not an
  implementation detail:
  - `null` — not normalised yet
  - `''` (or whatever D2-03's evaluator returns for a non-plate) — normalised to nothing
  - a string — the canonical `A-Z0-9` form D2-05 keys 235 watchlist rows on

  The per-camera rejection rate depends on telling the first two apart. Say in the handoff which
  value means which, and make it explicit in code.
- Decide deliberately whether normalisation belongs in the TypeScript consumer or the Python worker,
  and record why. The evaluator is TypeScript, so the consumer is the shorter path; the worker is
  closer to the read. **One of them, not both.**
- Do **not** backfill the existing 18 rows as the fix. A migration that rewrites history hides
  whether the write path works. If you backfill, do it as a separate, clearly-labelled step.

## Out of scope

- Changing normalisation or grammar rules. D2-03's `evaluatePlateRead` is the contract; if it looks
  wrong, log it rather than editing it.
- Changing the trace query, the alert correlation path, or anything in `packages/web`.
- Widening what counts as a match. This ticket makes an existing capability reachable; it does not
  add one.

## Acceptance Criteria

- [ ] Every `plate_reads` row written by the consumer carries a non-null `normalized_text` whenever
      the read normalises to anything, proven by a real round trip — not a fixture that sets the
      column itself
- [ ] The `null` / empty / value distinction is preserved and asserted by name in a test
- [ ] **The regression test that would have caught this: a plate that raises an alert is also
      returned by `GET /api/v1/trace`.** One end-to-end assertion, exercising the real write path,
      the real alert correlation and the real trace query against Postgres
- [ ] `GET /api/v1/trace?plate=<a plate read by the pipeline>` returns its sightings in
      chronological order by PTS
- [ ] The stored form matches what `services/alerts.ts` computes for the same `raw_text` — asserted,
      so the two paths cannot drift again
- [ ] No existing AC of D2-01, D2-03, D2-06 or D2-08 regresses: the full suite is green and the
      counts do not fall
- [ ] Per-camera rejection rate is still computable from `plate_reads` alone, and a query proving it
      is recorded in the ticket

## Validation Gate

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test
pytest workers -q
psql "$DATABASE_URL" -c "select count(*), count(normalized_text) from plate_reads;"
```

- [ ] Full suite green, with the new end-to-end assertion in it
- [ ] A comment on this issue stating: which layer now normalises and why, the three-way distinction,
      and the rejection-rate query

## Handoff → D2-GATE, D3-01, D3-02

`D2-GATE` re-runs after this. Say plainly whether the loop is closed, and give the exact query a
future session can use to check that `plate_reads.normalized_text` is being populated in a live run.
