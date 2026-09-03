---
title: "D4-08 · Triage the backlog into limitations and roadmap"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "docs", "submission"]
blocked_by: ["BL-01", "D3-GATE"]
estimate: "1.5h"
---

## Context

`BL-01` has been accumulating findings since Day 0. This ticket converts that raw log into two
scored assets:

- **Accepted limitations** → the deck's *"What this system does not do"* slide and the HLD's
  *Assumptions & Constraints*. Stating limits is what makes every other claim believable.
- **Roadmap** → the *Future Roadmap* dimension, which is mandatory and which most teams will fill
  with vague ambition instead of specifics discovered while building.

A limitation found and stated is a strength. The same limitation found by a judge is a hole.

## Scope

- Read every `BL-01` entry and classify: **fixed** · **accepted limitation** · **roadmap**
- For each accepted limitation write: what it is, why we accepted it, what it costs the user, and
  what would resolve it
- For each roadmap item write: what it unlocks, rough effort, and dependency on Gujarat Police
  (e.g. real VAHAN access, department MoUs, GPU procurement)
- Roadmap must be **specific and staged** — Phase 2 hardening, then pilot, then district, then
  statewide — mapping onto the challenge's own two-phase structure and the ₹18L Phase 1 grant
- Generate the two documents; wire them into the deck and HLD

## Acceptance Criteria

- [ ] Zero untriaged `BL-01` entries
- [ ] Every accepted limitation has all four fields (what/why/cost/resolution)
- [ ] Every roadmap item states what it unlocks and what it depends on
- [ ] Roadmap staged across pilot → district → statewide with rough numbers, not adjectives
- [ ] Deferred bonus tickets (`D3-03`, `D3-09`, `D3-10` if any were deferred) appear in the roadmap
- [ ] Deck's "does not do" slide and HLD's Assumptions section both generated from
      `docs/limitations.md` — no divergent hand-written copies
- [ ] `BL-01` closed with a summary comment

## Deliverables

- `docs/limitations.md`
- `docs/roadmap.md`
- `BL-01` closed with the triage summary

## Validation Gate

```bash
test -s docs/limitations.md && test -s docs/roadmap.md
gh issue view <BL-01 number> --json comments | jq '.comments|length'
grep -c "^### " docs/limitations.md docs/roadmap.md
```

- [ ] Both documents non-empty and structured
- [ ] Count of triaged items equals the count of `BL-01` entries (no silent drops)
- [ ] Deck and HLD both reference the generated files

## Handoff → D4-04, D4-05, D4-SUBMIT

Do this **before** finalising the deck and HLD — both consume these files.
