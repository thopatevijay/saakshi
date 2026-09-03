---
title: "D1-09 · Analytics worker skeleton: detections to database"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "cv", "pillar-3"]
blocked_by: ["D1-01", "D1-03"]
estimate: "3h"
---

## Context

This closes the Day 1 vertical slice: a real camera in, real detections in Postgres, visible in the
UI. No ANPR yet — that is D2-01/D2-02. The point is to prove the whole pipe end to end before adding
sophistication to any single stage.

## Scope

- Python worker (`workers/analytics/`): adapter-opened stream → YOLO11 detect → ByteTrack →
  `sightings` rows via the Valkey event bus
- **PTS-driven throughout.** Every sighting carries `frame_pts_ms` and an absolute `ts` derived from
  PTS + the stream epoch, never from arrival time.
- Motion gate before inference (skip static frames — most cameras are idle most of the time)
- Per-camera decoder + per-camera batch shape read from capabilities (no fixed-shape batch)
- Apple Silicon MPS and CUDA both supported, device auto-detected
- Worker assigned a camera subset by config; concurrency bounded
- Graceful handling of the eight organiser-declared failure modes (see `PROJECT.md §4`)
- Publishes to `sightings` stream; API consumer persists to Postgres

## Out of scope

- Plate detection / OCR / best-shot (D2-01, D2-02)
- Colour and body-type attributes (D2-02)

## Acceptance Criteria

- [ ] Worker processes ≥ 8 demo cameras concurrently on the target hardware without frame-loop stalls
- [ ] `sightings` rows land with correct `camera_id`, PTS-derived `ts`, `track_id`, bbox, confidence
- [ ] Track IDs are stable within a camera and **reset cleanly at the loop-point scene cut**
      (explicit test — no identity bleed across the cut)
- [ ] Reconnect with 2s→30s backoff proven by killing a feed mid-run
- [ ] Join-time decoder warnings logged, not fatal; the worker keeps going
- [ ] Mixed H.264/H.265 and mixed resolutions handled in one run
- [ ] Motion gate measurably reduces inference calls (log the skip ratio)
- [ ] Measured throughput recorded: cameras × effective fps × device — **this number feeds the
      sizing model in D3-08, so it must be real**
- [ ] No leaked capture handles or unbounded memory over a 20-minute run

## Deliverables

- `workers/analytics/` worker + device abstraction + tests
- `packages/api/src/consumers/sightings.ts` — bus → Postgres
- A comment on this issue with the measured throughput table

## Validation Gate

```bash
python -m workers.analytics.run --cameras <8 demo ids> --minutes 5
psql $DATABASE_URL -c "select camera_id, count(*), min(ts), max(ts) from sightings group by 1 order by 1;"
psql $DATABASE_URL -c "select count(distinct track_id) from sightings;"
pytest workers/analytics -q
```

- [ ] Rows present for all 8 cameras with sane timestamps (no future/epoch-zero values)
- [ ] 20-minute soak run: stable RSS, no handle leak
- [ ] Throughput table posted

## Handoff → D2-01, D3-08

The measured throughput number is the input to the whole GPU sizing argument. Post it as a comment.
