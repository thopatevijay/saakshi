---
title: "D2-01 · ANPR pipeline: best-shot selection, rectify, OCR, multi-frame vote"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "cv", "pillar-3", "mandatory-requirement"]
blocked_by: ["D1-09"]
estimate: "4h"
---

## Context

**ANPR is the only mandatory analytic in the challenge.** Proof: the bonus list reads *"Additional
reliable analytics beyond the mandatory ANPR requirement."* Everything in Pillar 3 depends on this
ticket working.

Two design moves do most of the accuracy work, and neither needs a CV specialist:
1. **Best-shot selection** — OCR *one* optimal frame per vehicle track, not every frame.
2. **Multi-frame voting** — aggregate reads across a track to cancel per-frame OCR noise.

Naively OCRing every frame is both slower and *less* accurate. Do not do it.

## Scope

```
track (from D1-09) → best-shot scoring → plate detect → rectify/deskew → OCR
                   → multi-frame vote across the track → plate_read row
```

- **Best-shot score** per frame in a track: plate bbox area × sharpness (Laplacian variance on the
  plate crop) × frontality (bbox aspect vs expected plate ratio). Keep the top-N frames.
- Plate detection: open-weights YOLO plate model. **Licence-check the weights and record the licence.**
- **Rectification**: perspective-correct the plate quad before OCR. Oblique plates OCR badly otherwise.
- OCR: `fast-plate-ocr` (ONNX) primary, PaddleOCR fallback behind one interface
- **Multi-frame vote**: per character position, weight votes by per-read confidence; emit the winning
  string with an aggregate confidence and `vote_count`
- Persist: one `plate_reads` row per track (best), linked to its `sighting`; keep the crop URI
- Every read stores its confidence — a read is never a bare string

## Out of scope

- Normalisation and grammar validation (D2-03) — store raw here
- Fuzzy matching (D2-04)
- Watchlist correlation (D2-06)

## Acceptance Criteria

- [ ] Best-shot selection implemented and **proven better than every-frame OCR**: a test on the same
      recorded segment shows equal-or-better accuracy at materially lower inference count, with both
      numbers recorded
- [ ] Rectification implemented; a test with a deliberately oblique plate shows improved read
- [ ] Multi-frame voting implemented; a synthetic test with 5 noisy reads of a known plate recovers
      the correct string
- [ ] OCR backend swappable via config with no code change (test proves both paths run)
- [ ] Every `plate_reads` row has: raw text, confidence, `vote_count`, `is_best_shot`, crop URI
- [ ] Plate-model weights licence recorded in `docs/model-licences.md`
- [ ] Runs on ≥ 8 demo cameras concurrently; throughput recorded
- [ ] **Measured precision/recall on a hand-labelled set of ≥ 50 plates from the sandbox feeds**,
      broken down by day/night. This number goes in the deck — it must be real, not aspirational.

## Deliverables

- `workers/analytics/anpr/` — best-shot, rectify, ocr backends, voting
- `fixtures/plate-eval/` — the hand-labelled evaluation set (≥50 plates) + label file
- `docs/anpr-accuracy.md` — method, dataset, measured precision/recall, **and where it fails**
- `docs/model-licences.md`

## Validation Gate

```bash
pytest workers/analytics/anpr -q
python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval   # prints P/R by condition
python -m workers.analytics.run --cameras <8 demo ids> --minutes 5 --anpr
psql $DATABASE_URL -c "select count(*), avg(confidence) from plate_reads;"
```

- [ ] Evaluation report generated with real numbers
- [ ] Best-shot-vs-every-frame comparison recorded as a comment on this issue
- [ ] Zero `plate_reads` rows with null confidence

## Handoff → D2-03, D2-04, D3-08

Post the measured P/R table and the throughput-with-ANPR figure. Both go straight into the deck and
the sizing model.
