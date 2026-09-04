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

**The deployed sandbox does not match the published Integrator's Guide.** Verified 2026-09-04, full
detail in `BL-01`. `scripts/recon.py` has been rewritten for the reality:

| | Reality | Guide claimed |
|---|---|---|
| Host | `cctv.corp8.cloud` (HTTPS/443, Cloudflare) | `<host>` placeholder |
| Catalogue | `GET /cameras.json` → `[{id,name}]` **only** | `/api/ingest` with codec, fps, live status, 3 URLs |
| Stream | `/<id>/index.m3u8` | `/live/stream/<id>/index.m3u8` (404) |
| RTSP / WHEP | **absent** | `:8554` / `:8889` |
| Nature | **VOD**, `PLAYLIST-TYPE:VOD` + `ENDLIST`, seekable | "live… no seeking, no byte-range" |

Also established: 30 cameras `cam01`–`cam30`; 7,200 × ~6 s segments = **12.0 h each**; AES-128
encrypted (key at `/enc.key`, handled transparently by ffmpeg); auth via a **`sentinel=<token>`
cookie** (every path 302s without it); and **Cloudflare rejects ffmpeg's default UA**, so a browser
User-Agent is mandatory.

**The footage window is `13-06-2026 21:00` → `14-06-2026 09:00` — roughly 9 of 12 hours are dark.**
Sampling only the start of the file gives a night-only view of the estate. Daylight sits at roughly
offsets 32400–43200 s.

## Scope

- `set -a; . ./.env; set +a` then run `scripts/recon.py` across **every** camera
- The script samples each camera at three offsets (night · pre-dawn · **day**) and measures codec,
  resolution, true fps and duration — none of which the catalogue declares
- **Eyeball every day frame in `recon-out/frames/`.** The automated plate score is a proxy, not truth
- Record results in `.dev-refs.md` **and** as a comment on this issue (the file is gitignored)
- Choose the demo camera shortlist

## Out of scope

- Any inference beyond the recon script's own sampling
- Any DB writes (no schema exists yet)
- Fixing the adapter framework for HLS — that is `D1-03`

## Acceptance Criteria

- [ ] `recon-out/catalogue.json` captured — the raw `/cameras.json` payload
- [ ] `recon-out/report.json` + `report.csv` produced for **all 30** cameras
- [ ] Day **and** night frames sampled per camera and **visually reviewed by a human**
- [ ] Measured properties recorded per camera: codec, resolution, fps, duration, segment count.
      Note the resolution spread — `cam01` is 1920x1080 and `cam12` is 1280x720, so the estate is
      genuinely heterogeneous (evidence for Pillar 1 and for D1-09's per-camera batch shapes)
- [ ] **10–12 demo cameras selected**, written into `.dev-refs.md` with reasons, and posted here
- [ ] Cameras classified by geometry, because it drives everything downstream:
      - **ANPR-viable** — aimed at stop lines / toll lanes (e.g. `cam14` Delight RLVD,
        `cam12` Adalaj Tollnaka): vehicles pass close, slow, near-frontal
      - **Detection-only** — wide or PTZ overview (e.g. `cam01` Chiman bhai Bridge): plates are a
        few pixels; useful for vehicle detection and counting, not ANPR
- [ ] **PTZ cameras identified** (the burned-in overlay names them, e.g. `CSITMS-32_PTZ2`) and
      flagged — their field of view changes during the recording
- [ ] Datacenter-IP reachability tested (D0-02 Q4) and the GPU decision recorded. `corp8.cloud` is
      ordinary cloud infrastructure, so this is likely to pass — but test, do not assume
- [ ] **Go / re-weight decision recorded** as a comment:
      - *Go* — enough ANPR-viable cameras; proceed as planned
      - *Re-weight* — shift emphasis to Pillars 1/2/4, route inference carries Pillar 3, and ANPR
        claims scale to measured reality

## Deliverables

- `recon-out/` (gitignored) — catalogue, report, day/night frames
- `.dev-refs.md` — host, endpoints, cookie handling, camera table
- A comment on this issue with the summary table, the camera classification, and the decision

## Validation Gate

```bash
set -a; . ./.env; set +a
python3 scripts/recon.py
test -s recon-out/catalogue.json && test -s recon-out/report.csv
ls recon-out/frames/*_day.jpg | wc -l          # one daylight frame per decodable camera
python3 - <<'PY'
import json; r = json.load(open('recon-out/report.json'))
live = [x for x in r if x['decodable']]
assert len(live) >= 24, f"only {len(live)}/30 decodable — escalate to helpdesk"
anpr = [x for x in live if (x['best_plate_score'] or 0) >= 55]
print(f"decodable {len(live)}/{len(r)} · ANPR-candidate {len(anpr)}")
print("resolutions:", {f"{x['width']}x{x['height']}" for x in live})
PY
```

- [ ] At least 24 of 30 decodable, or a helpdesk ticket raised and logged in `BL-01`
- [ ] At least 4 cameras judged **by eye** to have ANPR-viable geometry, or the re-weight decision
      is taken deliberately and recorded

## Handoff → D1-03, D1-04, D1-05, D1-09, D2-01

Post as a comment: the demo camera ids with their classification, the codec/resolution spread, and
the daylight offset window. Adapter tests, batch shapes, trust-score calibration and the ANPR
evaluation set all depend on these.
