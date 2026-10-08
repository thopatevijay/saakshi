---
title: "D4-17 · The detection overlay draws nothing once a recording has been analysed more than once"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "bug", "demo-critical", "frontend", "backend"]
blocked_by: []
estimate: "2h"
---

## Context

On 8 Oct 2026, `/video-wall?camera=<cam04>` played the sandbox stream correctly with the overlay on
(`layout.overlay: true`), yet **no detection box was ever drawn**: the overlay canvas had 0 painted
pixels.

Root cause, measured:

- The sandbox serves **VOD**. Every analytics-worker run replays the recording from PTS 0, so every
  run writes a fresh set of sightings **for the same frames**. cam04 has 1,049,365 sightings across
  only 5.4 min of PTS, written by ~29 runs between 5 and 7 Oct.
- In one second of cam04 PTS (39,000–40,000 ms) there are **9,050 rows across 26 frames, about 348
  rows per frame**. Each run's `track_id` is session-qualified, so `(frame_pts_ms, track_id)` does
  **not** collapse the duplicates (6,055 distinct pairs).
- The overlay (`detection-overlay.tsx`) requests an **8 s** window with `limit=500`; the API caps
  `limit` at 500 and orders by `frame_pts_ms`. The 500 rows cover **40 ms of video (2 frames)**:
  measured window 39,081–47,081 returned PTS 39,120–39,160 only. `detectionsAt()` draws only rows
  within 120 ms of the playhead, so after a moment nothing matches.

This will recur on stage after any rehearsal run against a VOD source.

Also seen: the first load of that URL got **503** from the manifest server action and rendered
"No stream available for this camera" (a reload fixed it). Investigate only far enough to say
whether it's in this path.

## Scope

1. **`GET /api/v1/streams/:id/detections` returns one run's detections per frame.** For each
   `frame_pts_ms` in the window, return only the rows of the **most recent run** that covered that
   frame. Rows from different runs of the same frame differ in `ts` (each run anchors its own epoch),
   so "the rows whose `ts` is the latest for that `frame_pts_ms`" identifies one run per frame. The
   chosen rule must be documented in the route's module note, and it must not change what any other
   consumer (trace, alerts, export) sees.
2. **The window and the limit agree.** A single run on a busy junction is ~10–20 boxes per frame at
   25 fps, so a window of 8 s cannot fit in 500 rows. Make the client window and the server limit
   consistent (e.g. a shorter window, a higher cap, or the client paging until it covers the
   window). Whatever is chosen, **a truncated response must never be mistaken for a complete one**:
   if the server stopped at the limit, the response says so and the client refetches from where it
   stopped.
3. **It stays fast.** cam04 holds over 1M rows. Add an index if the query plan needs one
   (migration up and down), and measure.

### Out of scope
De-duplicating sightings at ingest time, or deleting old runs. The data is evidence and stays.
Log the ingest-side question to BL-01 instead.

## Acceptance Criteria

- [ ] On cam04's current data, a detections request for any 1 s window returns rows from exactly
      one `ts` per `frame_pts_ms` (proven by an API test with two seeded runs over the same frames,
      and by a query against the live data)
- [ ] The overlay draws boxes: in Chrome, `/video-wall?camera=<cam04 uuid>` with overlay on shows
      boxes on vehicles. Evidence: a screenshot, and the canvas painted-pixel count is > 0 on at least
      90% of 1 s samples over 30 s of playback within the analysed range (PTS 0–5.4 min)
- [ ] A response cut by the limit is flagged as such, and the client covers the full window anyway
      (unit test on the client fetch logic)
- [ ] p95 of the detections endpoint on cam04 ≤ 300 ms over 50 requests at random windows in the
      analysed range (measured, numbers in the PR)
- [ ] Trace, alerts and export output for cam04 are unchanged (their tests still pass; no shared
      query was modified)
- [ ] The 503 on first load is explained in the PR: fixed here if it is in this path, otherwise
      logged to BL-01 with what was found
- [ ] `npm run typecheck && npm run lint` green, and the affected test files green

## Deliverables

- `packages/api/src/routes/streams.ts` (+ a migration if an index is needed)
- `packages/web/app/(shell)/video-wall/detection-overlay.tsx`
- Tests for both halves

## Validation Gate

```bash
npm run typecheck && npm run lint
npx vitest run packages/api/src/routes/streams.test.ts
npx vitest run packages/web/src/lib/wall
# live: cam04 detections window → one ts per frame_pts_ms; p95 timing over 50 requests
# browser: screenshot of boxes on cam04, painted-pixel samples
```
