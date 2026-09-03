---
title: "D2-03 · Plate normalisation and Indian plate grammar validator"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "pillar-3"]
blocked_by: ["D2-01"]
estimate: "2h"
---

## Context

Before matching anything, reads must be comparable. And Indian plates have a **grammar** —
`<state:2 alpha><rto:1-2 digit><series:1-3 alpha><number:4 digit>` (e.g. `GJ01AB1234`), with known
variants (BH series, older formats, military, diplomatic). Structurally impossible reads can be
corrected or down-weighted *before* they pollute the index.

This is cheap, deterministic logic that materially raises match quality. No model involved.

## Scope

- Normalisation: uppercase, strip separators/whitespace, strip `IND` prefixes and state-emblem noise
- Grammar validator covering: standard format, BH-series, 2-digit and 1-digit RTO codes,
  1–3 char series, and known legacy formats. Valid state codes enumerated (GJ, MH, RJ, DL, …).
- Grammar-guided correction: where a character sits in a slot that must be alpha but was read as a
  confusable digit (and vice versa), correct it and **record that a correction was made**
- Output per read: `normalized_text`, `grammar_valid`, `grammar_corrected`, `corrections[]`,
  `adjusted_confidence`
- Never silently discard a read — an ungrammatical read is stored, flagged, and down-weighted

## Acceptance Criteria

- [ ] Normalisation is idempotent and total (never throws on garbage input)
- [ ] Validator correctly accepts a table of ≥ 20 real valid formats and rejects ≥ 10 invalid ones
      (fixture-driven table test)
- [ ] Slot-aware correction implemented: `GJO1AB1234` → `GJ01AB1234` with the correction recorded
- [ ] `adjusted_confidence` reduced for corrected and for ungrammatical reads, by a documented rule
- [ ] Ungrammatical reads are retained and flagged, never dropped
- [ ] State-code list documented and easily extendable
- [ ] Pure functions, fully unit tested, zero I/O

## Deliverables

- `packages/shared/src/plate/{normalise,grammar}.ts` (shared so the worker and API agree)
- `fixtures/plate-grammar-cases.json` — the valid/invalid table
- `docs/plate-grammar.md` — the format spec we implement, with sources

## Validation Gate

```bash
npm run test -w packages/shared -- plate
node -e "const{normalise,validate}=require('./packages/shared/dist/plate');console.log(normalise(' ind gj-01 ab 1234 '), validate('GJO1AB1234'))"
```

- [ ] All table cases pass
- [ ] Idempotency property test passes (`normalise(normalise(x)) === normalise(x)`)

## Handoff → D2-04

The fuzzy index keys on `normalized_text`. Confirm the exact normalised form as a comment.
