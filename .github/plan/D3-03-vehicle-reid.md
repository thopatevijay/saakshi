---
title: "D3-03 · Vehicle re-ID bridging for unreadable plates"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "cv", "pillar-3", "bonus", "stretch"]
blocked_by: ["D2-02", "D2-08"]
estimate: "4h"
---

## Context

In real Indian CCTV most frames have an unreadable plate — angle, night, blur, two-wheelers, mud, no
front plate. A pure-ANPR trace therefore has holes.

Re-ID closes them: from one confident plate **anchor**, propagate identity to cameras where the plate
was illegible but the vehicle is visibly the same. This is bonus item *"advanced cross-camera vehicle
movement tracking or multi-camera correlation."*

**This is the most CV-specialist ticket in the project and it is first on the cut list.** If Day 3 is
running short, close it as deferred, log to `BL-01`, and put it in the roadmap. The trace works
without it.

## Scope

- Vehicle appearance embedding from the best-shot vehicle crop (pretrained vehicle re-ID model;
  no training)
- Gallery per `vehicle_identity`, seeded by sightings that have a **confident plate read** (anchors)
- Candidate linking: unlinked sightings within a plausible spatio-temporal window compared against
  the gallery; link when similarity exceeds a calibrated threshold
- **Spatio-temporal gating is mandatory** — appearance alone will link every white hatchback in
  Gujarat. Candidates must be reachable per the D3-01 travel-time model.
- New link method `reid` with its own confidence, visually distinct in the trace UI
- Colour-constancy handling across cameras (different white balance) documented and mitigated
- Threshold calibrated on a labelled set; **precision prioritised over recall** — a wrong link
  corrupts an evidentiary route, which is far worse than a missing link

## Acceptance Criteria

- [ ] Embeddings computed for best-shot crops; gallery built from plate-anchored identities
- [ ] Spatio-temporal gate applied before any appearance comparison (test proves an ungated match is rejected)
- [ ] Threshold calibrated on a labelled set of ≥ 30 positive and ≥ 30 negative pairs;
      **measured precision ≥ 0.9** or the feature ships disabled by default
- [ ] `reid`-linked sightings flagged distinctly in the API and UI; filterable and excludable
- [ ] A trace can be rendered plate-only (re-ID off) — the officer chooses the evidentiary standard
- [ ] Measured trace-completeness improvement recorded: sightings found with vs without re-ID
- [ ] If precision target is not met: feature disabled by default, honestly documented, logged to `BL-01`

## Deliverables

- `workers/analytics/reid.py`
- `fixtures/reid-eval/` labelled pairs
- `docs/reid.md` — model, licence, gating, calibration, **measured precision**, limitations
- Comment with the with/without completeness comparison

## Validation Gate

```bash
pytest workers/analytics -q -k reid
python -m workers.analytics.eval_reid --fixtures fixtures/reid-eval   # prints precision/recall
curl -fsS "localhost:4000/api/v1/trace?plate=<known>&include_reid=true" | jq '[.sightings[].link_method]|group_by(.)|map({(.[0]):length})'
```

- [ ] Precision ≥ 0.9 on the labelled set, or the feature is disabled with documentation
- [ ] Plate-only trace still works with re-ID off

## Handoff → D4-04

If deferred, say so explicitly in the deck's roadmap rather than implying the capability exists.
