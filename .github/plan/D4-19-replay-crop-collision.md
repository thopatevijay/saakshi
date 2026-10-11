---
title: "D4-19 · Plate crops attach to the oldest replay, and alert crop caveats are frozen"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4","bug","demo-critical","backend"]
blocked_by: []
estimate: "2h"
---

## Context
Measured 10 Oct: the evidence consumer's `findPlateRead` (`packages/api/src/consumers/evidence.ts`) matches a plate crop to a read by `(camera_id, track_id, frame_pts_ms)` with `order by p.created_at limit 1`. The sandbox is VOD, so every replay produces the same key: e.g. track 14 @ 8150 ms has 12 plate reads and only the oldest has an `s3://` crop. Each new crop overwrites the oldest row's crop and the new read stays `file://`. All 4 alerts on 10 Oct had no crop; 41% of that day's plate reads were stuck on `file://`.
Separately, `alerts.reason.caveats` / `reason.evidence` are written once at alert time, before the crop lands, so every alert's caveat says "no crop URL" even after the crop exists (0 of 52 alerts had a crop at creation time).

## Scope
1. A plate crop attaches to **its own** read: the newest read for that key that does not already have an `s3://` crop (or carry the read identity on the evidence record, if cleaner). Check `findSighting` (vehicle crops) for the same collision and fix it the same way if present.
2. The alert's crop state shown to an officer reflects the **current** crop, not the frozen snapshot: evaluate the evidence/crop caveat at read time in `GET /api/v1/alerts` and `/alerts/:id`, without rewriting the stored reason.

## Acceptance Criteria
- [ ] Test: two replays over the same `(camera, track, pts)`; each plate crop lands on its own read; neither overwrites the other
- [ ] Live (sandbox, worker running): plate reads written after the fix get `s3://` crops; report the `file://` vs `s3://` ratio for reads created after the fix
- [ ] An alert created before its crop arrived shows the crop, and no "no crop URL" caveat, once the crop exists (test + one live alert)
- [ ] `findSighting` checked: fixed or proven unaffected, with evidence
- [ ] typecheck, lint and the affected test files green
