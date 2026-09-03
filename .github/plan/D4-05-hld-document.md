---
title: "D4-05 · Technical proposal / High-Level Design document"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "submission", "mandatory-deliverable", "docs"]
blocked_by: ["D3-GATE", "D3-08"]
estimate: "3h"
---

## Context

**Mandatory submission item 2**, scored as evaluation area #3 ("Solution Architecture"). The problem
statement lists exactly what the HLD must cover — that list is the specification.

Most of this is already written across `docs/`. This ticket assembles, reconciles, and fills gaps —
it does not start from a blank page.

## Scope — required content, per the problem statement

- Overall solution architecture with high-level diagrams and component interactions
- Approach for integrating heterogeneous cameras, NVRs and VMS into a unified platform
  (IP, analog, multi-vendor, varied protocols) → from `docs/adapter-framework.md`
- Architecture for ingesting, processing and managing live streams from geographically dispersed
  locations (bandwidth, connectivity, edge vs centralised)
- Approach for integrating live feeds with watchlist databases (stolen vehicles, wanted persons,
  missing persons, blacklisted vehicles, suspect watchlists) and continuously correlating analytics
  results to generate real-time alerts → from `docs/watchlist-integration.md`, `docs/alerting.md`
- AI-powered analytics approach: **ANPR** (mandatory), object detection, person/vehicle tracking,
  and our additional analytics. State plainly that **FRS is deliberately out of scope**, and why.
- Alert generation and notification workflow: prioritisation, visualisation, user interaction
- Scalability, interoperability, security and performance for statewide deployment to ~80,000 cameras
- **Technical prerequisites, assumptions, and information required from participating departments**
  → from `docs/department-onboarding-questionnaire.md` (D4-06)
- Assumptions & Constraints section → accepted limitations from `BL-01`

Diagrams required: system context · edge/district node · data flow (frame → sighting → alert) ·
deployment topology · trust-score pipeline · audit chain. Source files committed, not just images.

## Acceptance Criteria

- [ ] Every bullet from the problem statement's HLD list is addressed, each under a heading that
      names it, so a scorer can tick it off
- [ ] All six diagrams present, legible, with committed sources (mermaid or drawio)
- [ ] Sizing and scalability sections generated from `docs/sizing-model.md`
- [ ] FRS-out-of-scope stated with reasoning
- [ ] Watchlist section states clearly that connectors are specified but not live, and what Gujarat
      Police would need to provide
- [ ] Assumptions & Constraints populated from `BL-01`
- [ ] No contradiction with the deck (numbers, model choice, capability claims) — verified by reading
      both in one sitting
- [ ] Exported to PDF; internal links resolve

## Deliverables

- `docs/HLD.md` + `submission/saakshi-hld.pdf`
- `docs/architecture/*.mmd` (or `.drawio`) diagram sources + rendered PNGs

## Validation Gate

```bash
npm run docs:render        # mermaid -> png, md -> pdf
test -s submission/saakshi-hld.pdf
npm run docs:linkcheck     # zero broken internal links
```

- [ ] Requirement-by-requirement checklist pass against the `/problems` HLD list
- [ ] Deck/HLD consistency read-through completed and recorded

## Handoff → D4-SUBMIT

Both PDFs go into the submission. Confirm the file sizes are within any portal upload limit.
