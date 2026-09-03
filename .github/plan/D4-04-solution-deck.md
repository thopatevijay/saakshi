---
title: "D4-04 · Solution presentation deck: all ten mandatory dimensions"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "submission", "mandatory-deliverable", "docs"]
blocked_by: ["D3-GATE", "D3-08"]
estimate: "3h"
---

## Context

**Mandatory submission item 1**, and scored as evaluation area #2. The problem statement enumerates
what must be covered — treat that list as the table of contents, not as inspiration.

## Scope — required content

Model choice and justification first: **Model 1 + Model 3**, with the reasoning from
`PROJECT.md §2` (Model 4's 160 Gbps and its political impossibility; Model 2's organisational
non-scalability).

The ten mandatory design dimensions, each as a slide:
1. Overall Architecture · 2. Integration Strategy · 3. AI & Video Analytics ·
4. Cybersecurity Architecture · 5. Deployment Architecture · 6. Infrastructure Sizing ·
7. Cost-Benefit Analysis · 8. **Department-wise Information Requirements** ·
9. Scalability Strategy · 10. Future Roadmap

Plus the differentiator slides:
- **The registry that tells the truth** — trust score, with the real measured-vs-declared FPS finding
- **Trusted-vs-all coverage delta** from the gap analysis (a single striking number)
- **The retention clock** — evidence expiring on a 7–15 day clock nobody tracks
- **Impossible-transition / plate cloning**
- **Chain of custody** — hash-chained audit, verified export bundles (aimed at the NFSU jury)
- **The 125× backhaul argument** — arithmetic, not a claim
- **"What this system does not do"** — see `PROJECT.md §11`. In a room of overpromising vendors this
  is the slide that makes everything else believable.

Rules:
- **Every number on every slide is traceable to a ticket comment.** No unsourced figures.
- Measured accuracy matches D4-03's report exactly.
- No claim of live VAHAN/eGujCop connectivity. No face recognition. No unfalsifiable "AI" language.
- Screenshots from `docs/screenshots/`, all from the real running system.

## Acceptance Criteria

- [ ] All ten dimensions present, each explicitly labelled so a scorer can find it
- [ ] Model choice slide states which model(s) we submit under, matching the official numbering
      (per D0-02 Q1)
- [ ] Every quantitative claim cross-referenced to its source ticket in the speaker notes
- [ ] Measured ANPR accuracy identical to `submission/govt-feed-output-report.pdf`
- [ ] "What this system does not do" slide included, verbatim from `PROJECT.md §11` plus any
      accepted limitations from `BL-01`
- [ ] Sizing and cost slides generated from `docs/sizing-model.md`, not hand-typed
- [ ] Roadmap slide populated from `BL-01`'s roadmap list
- [ ] Exported to PDF; ≤ 20 slides; readable at 100% zoom on a projector
- [ ] Reviewed once end to end against the `/problems` page requirement list, item by item

## Deliverables

- `submission/saakshi-solution-deck.pdf` (+ source)
- `docs/claims-provenance.md` — every printed number → its source ticket

## Validation Gate

- [ ] Checklist pass against the ten dimensions, ticked one by one
- [ ] Cross-check every number against `docs/claims-provenance.md`
- [ ] Accuracy figure matches D4-03 exactly
- [ ] PDF opens cleanly and is legible at projector scale

## Handoff → D4-SUBMIT

The deck and the HLD must not contradict each other. Read both back to back before submitting.
