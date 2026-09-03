---
title: "D3-08 · Infrastructure sizing and cost calculator (in-product)"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "frontend", "backend", "differentiator", "scored-dimension"]
blocked_by: ["D1-09", "D2-01", "D2-02"]
estimate: "3h"
---

## Context

*Infrastructure Sizing* and *Cost-Benefit Analysis* are two of the ten mandatory design dimensions,
and *Scalability and PoC Readiness* is a scored evaluation area. Every other team will put a static
table in a PDF.

**We ship a working calculator, driven by our own measured throughput.** That is the difference
between a claim and a model. It is also the cheapest credibility we can buy: the arithmetic is
checkable on a napkin, and it comes from real numbers gathered in D1-09, D2-01 and D2-02.

## Scope

- Inputs (sliders/fields): camera count · % requiring continuous ANPR · retention days ·
  events/camera/day · crop retention policy · edge vs central split · GPU class
- Outputs, computed live:
  - **Backhaul**: central-video Gbps vs metadata-only Gbps, and the ratio
  - **GPU count** from measured streams-per-GPU (D1-09/D2-01), split across district edge nodes
  - **Storage**: metadata TB/yr and crop TB/yr under the chosen retention, hot/warm/cold split
  - **Cost**: capex and annual opex ranges, with every unit-cost assumption visible and editable
- Preset scenarios: `Pilot (500 cams)` · `District (5,000)` · `Statewide (80,000)`
- **Every constant is sourced and labelled** — measured (with the ticket it came from), vendor-listed,
  or assumed. No unattributed numbers.
- Export the current scenario to Markdown for the HLD and deck

## Acceptance Criteria

- [ ] All inputs wired; outputs recompute live with no lag
- [ ] Statewide preset reproduces the `PROJECT.md §9` first-pass figures (160 Gbps vs ~1.3 Gbps,
      ~125×; ~960 GPUs at 30% ANPR coverage and 25 streams/GPU) — or **the discrepancy is
      investigated and `PROJECT.md` is corrected**
- [ ] Streams-per-GPU comes from **measured** D1-09/D2-01 throughput, not a literature value
- [ ] Storage model uses the **measured** bytes-per-1,000-sightings from D2-02
- [ ] Every constant displays its provenance tag (measured / listed / assumed)
- [ ] Scenario export produces Markdown suitable for direct paste into the HLD
- [ ] A sanity test asserts the arithmetic against a hand-computed fixture scenario

## Deliverables

- `packages/web/app/sizing/*` + `packages/shared/src/sizing/model.ts` (pure, testable)
- `docs/sizing-model.md` — generated from the statewide preset, with all provenance
- `docs/screenshots/sizing.png`

## Validation Gate

```bash
npm run test -w packages/shared -- sizing     # hand-computed fixture must match
npm run export:sizing -- --scenario statewide > docs/sizing-model.md
test -s docs/sizing-model.md
npm run build -w packages/web
```

- [ ] Fixture arithmetic test green
- [ ] Statewide export matches (or corrects) `PROJECT.md §9`
- [ ] Every constant carries provenance

## Handoff → D4-04, D4-05

`docs/sizing-model.md` is a direct input to two mandatory HLD dimensions. Do not hand-write those
sections — generate them here.
