---
title: "D1-05 · Trust prober worker: health signals per camera"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "cv", "pillar-1", "differentiator"]
blocked_by: ["D1-01", "D1-03", "D1-04"]
estimate: "3h"
---

## Context

**This is our highest-differentiation cheap feature.** A registry that lists dead cameras is worse
than no registry — it creates false assurance. Nobody else will build this, and it is cheap:
classical CV, no models, no GPU.

The organisers' guide warns that declared FPS lies. We **measure it and display the delta**. That
single column tells the jury we read their documentation.

## Scope

Python worker (`workers/prober/`) computing per camera, on a schedule:

| Signal | Method |
|---|---|
| `connectable` | RTSP/TCP connect + time-to-first-frame |
| `decodable` | first IDR decoded successfully |
| `measured_fps` | frame count over a 30 s **PTS** window |
| `actual_resolution` / `actual_codec` | from the decoded stream |
| `blur_score` | variance of Laplacian, centre crop |
| `luma_mean` / `night_usable` | luma histogram; degraded flag after dark |
| `tamper_score` | long-window frame differencing + edge-density collapse |
| `pts_drift_ms` | PTS vs wall clock at connect |

Rules:
- **All timing from PTS**, never arrival time. The gateway replays a buffered GOP on connect, so an
  arrival-time metric is wrong on every reconnect.
- Discard the first ~2 s of frames after connect (the GOP replay burst) before measuring FPS.
- Non-uniform frame intervals are normal — a gap is not a disconnect.
- Join-time decoder warnings (`Error constructing the frame RPS`, `Could not find ref with POC`)
  are logged, never fatal.
- Survive the loop-point scene cut without flagging tamper.
- Open only the camera being probed; close it immediately after.

## Acceptance Criteria

- [ ] Worker probes every `active` camera and writes one `camera_health_checks` row per pass
- [ ] `measured_fps` computed from PTS and **excludes the connect burst** — proven by a test that
      asserts the first 2 s are dropped
- [ ] Declared-vs-measured FPS divergence flagged per camera
- [ ] Blur, luma, tamper, PTS-drift all populated with documented thresholds
- [ ] A deliberately covered/black feed scores high tamper; a normal feed does not
- [ ] The loop-point scene cut does **not** produce a false tamper flag (explicit test)
- [ ] Decoder warnings on join are logged and the probe still completes
- [ ] Runs against all D0-01 demo cameras without a crash or a leaked capture handle
- [ ] Idempotent and safely re-runnable; concurrent probes bounded by a configurable pool

## Deliverables

- `workers/prober/` — worker, thresholds config, tests
- `docs/trust-score.md` — every signal, its method, its threshold, and its rationale

## Validation Gate

```bash
python -m workers.prober.run --once --all
psql $DATABASE_URL -c "select count(*) from camera_health_checks where checked_at > now()-interval '10 min';"
psql $DATABASE_URL -c "select camera_id, measured_fps, blur_score, pts_drift_ms, tamper_score from camera_health_checks order by checked_at desc limit 12;"
pytest workers/prober -q
```

- [ ] One row per active camera in the last pass
- [ ] No null values in any signal column for decodable cameras
- [ ] All prober tests pass, including the false-tamper and connect-burst tests

## Handoff → D1-06

Publish the raw signal ranges observed across the real estate as a comment — the scoring weights in
D1-06 must be calibrated against real data, not invented.
