---
title: "D0-01 · Recon: catalogue and probe the Sentinel camera grid"
milestone: "Day 0 — Recon & Bootstrap"
labels: ["day-0", "recon", "blocker-risk", "cv"]
blocked_by: []
estimate: "2h"
---

## Context

This is the single ticket that can invalidate the architecture. The whole ANPR-led plan assumes the
sandbox feeds have readable plates. **No feature code is written until this ticket closes.**

`scripts/recon.py` already exists. This ticket is about running it, interpreting it, and recording
the outcome as fact.

Per the organisers' integrator guide: `GET /api/ingest` is **the contract**; the URL pattern is not.
Camera IDs and the camera set can change.

## Scope

- Log into the portal, obtain the sandbox host and any required session cookie
- Run `scripts/recon.py` across **every** camera in the catalogue
- Eyeball every saved frame in `recon-out/frames/` — the automated plate score is a proxy, not truth
- Record the results in `.dev-refs.md`
- Decide the demo camera shortlist

## Out of scope

- Any inference beyond the recon script's own sampling
- Any DB writes (no schema exists yet)

## Acceptance Criteria

- [ ] `recon-out/catalogue.json` captured — the raw `/api/ingest` payload
- [ ] `recon-out/report.json` + `report.csv` produced for **all** catalogued cameras
- [ ] One sample frame saved per decodable camera and **visually reviewed by a human**
- [ ] Counts recorded: total catalogued · decodable · dead · declared-FPS-wrong · PTS unavailable
- [ ] Codec mix recorded (H.264 vs H.265 split) and resolution spread recorded
- [ ] **10–12 demo cameras selected** and written into the `.dev-refs.md` table with reasons
- [ ] Datacenter-IP reachability tested (see D0-02) and the GPU decision recorded
- [ ] **Go / re-weight decision recorded** in this issue as a comment:
      - *Go* — enough cameras have readable plates; proceed with the plan as written
      - *Re-weight* — plates largely unreadable; shift emphasis to Pillars 1/2/4, route inference
        carries Pillar 3, and ANPR claims are scaled to measured reality

## Deliverables

- `recon-out/` (gitignored) with catalogue, report, frames
- `.dev-refs.md` — sandbox host, endpoints, camera count, codec mix, demo camera table
- A comment on this issue containing the summary table and the Go/re-weight decision

## Validation Gate

```bash
test -s recon-out/catalogue.json && test -s recon-out/report.csv \
  && ls recon-out/frames/*.jpg | wc -l
python3 - <<'PY'
import json; r=json.load(open('recon-out/report.json'))
live=[x for x in r if x['decodable']]
assert len(live)>=8, f"only {len(live)} decodable cameras — escalate to helpdesk before proceeding"
print(f"OK: {len(live)}/{len(r)} decodable")
PY
```

- [ ] At least 8 cameras decodable, or a helpdesk ticket raised and logged in `BL-01`
- [ ] Demo shortlist committed to `.dev-refs.md` (file is gitignored — so also paste the table into
      this issue as a comment, so any future session can recover it)

## Handoff → D1-03, D1-05, D2-01

The demo camera IDs, codec mix, and resolution spread determine adapter test cases and inference
batch shapes. **Post them as an issue comment**, not only to the gitignored file.
