---
title: "D4-03 · Government-feed demonstration and output report"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "submission", "mandatory-deliverable", "critical"]
blocked_by: ["D3-GATE"]
estimate: "3h"
---

## Context

**Mandatory submission item 4, and it maps directly onto evaluation area #1 ("Successful Test
Case") — the highest-weighted thing in the rubric.**

Required: onboard the government-provided feed(s), demonstrate successful onboarding and live or
recorded viewing, demonstrate available analytics output, and submit *"a screen-recorded video along
with an output report showing detected vehicles or number plates with corresponding timestamps."*

Note the organisers' careful wording — *"available* video-analytics output" — acknowledging the feeds
may not yield perfect plate reads. **Report what is actually there. Do not inflate.**

## Scope

- Onboard the sandbox government cameras through the adapter framework, on camera
- Demonstrate the video wall on government feeds (unified viewing across departments)
- Demonstrate ANPR output on the feeds, with confidences shown
- Demonstrate watchlist correlation using the seeded plates that genuinely appear (from D2-05)
- Demonstrate a vehicle trace across multiple government cameras with the reconstructed route
- **Output report** — the graded artefact:
  - CSV: camera id, camera name, department, plate text, normalised plate, confidence,
    **timestamp (PTS-derived, absolute)**, crop reference
  - PDF: the same table plus the crop thumbnails, a summary of cameras onboarded, reads produced,
    and **measured accuracy with its method stated**
  - A stated limitations section: which cameras produced no reads and why (night, angle, resolution)
- Video: 2–3 minutes, same discipline as D3-11 — live system only

## Acceptance Criteria

- [ ] Onboarding of government feeds shown live in the recording, not pre-baked
- [ ] Multi-department unified viewing demonstrated
- [ ] ANPR output demonstrated on government feeds with visible confidences
- [ ] Watchlist correlation fires on camera against a government feed
- [ ] Cross-camera trace demonstrated on government cameras with route reconstruction
- [ ] **CSV output report generated from the live database**, not hand-assembled — every row traceable
      to a `plate_reads` id
- [ ] PDF report includes crops, summary counts, measured accuracy **and** the limitations section
- [ ] Every timestamp in the report is PTS-derived and absolute; a spot check of 5 rows against the
      source frames confirms correctness
- [ ] Video 2:00–3:00, 1080p, text legible after compression
- [ ] Uploaded unlisted; URL recorded
- [ ] No credentials or PII in any frame; report contains no data we are not entitled to publish

## Deliverables

- `npm run report:anpr-output -- --from <t> --to <t>` → CSV + PDF
- `submission/govt-feed-output-report.{csv,pdf}`
- Unlisted YouTube URL recorded in `.dev-refs.md` and as a comment
- `docs/demo-govt-feed-storyboard.md`

## Validation Gate

```bash
npm run report:anpr-output -- --from <t> --to <t>
test -s submission/govt-feed-output-report.csv && test -s submission/govt-feed-output-report.pdf
python3 - <<'PY'
import csv
rows=list(csv.DictReader(open('submission/govt-feed-output-report.csv')))
assert rows, "empty report"
assert all(r['timestamp'] and r['confidence'] for r in rows), "missing timestamp/confidence"
print(f"{len(rows)} reads across {len({r['camera_id'] for r in rows})} cameras")
PY
```

- [ ] Report non-empty, every row has a timestamp and a confidence
- [ ] 5-row spot check against source frames passes
- [ ] Video reviewed end to end on a second device

## Handoff → D4-04, D4-SUBMIT

The measured accuracy in this report **must match** the number in the deck. Reconcile them before submitting.
