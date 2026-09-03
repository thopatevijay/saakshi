---
title: "D2-06 · Alert engine: dedupe, severity, and the 'why' payload"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "pillar-4", "differentiator"]
blocked_by: ["D2-04", "D2-05"]
estimate: "3h"
---

## Context

**The real failure mode of every alert system is fatigue, not accuracy.** 80,000 cameras with naive
alerting produces an unusable firehose, and an unusable system gets switched off. Nobody else will
design for this, because it only shows up in production.

Design constraint: **if an officer cannot verify an alert in three seconds, it is noise.**

## Scope

- Continuous correlation: every new `plate_reads` row → watchlist lookup (exact + fuzzy) → alert
- **Dedupe** on `(watchlist_entry_id, camera_id, time_bucket)` with a configurable window
  (default 10 min). Re-sighting at the same camera updates the existing alert's last-seen rather
  than creating a new row.
- **Severity from the watchlist category**, never from a model's opinion:
  `wanted_person > stolen_vehicle > blacklisted_vehicle > suspect > missing_person` (configurable)
- **"Why" payload on every alert** — non-negotiable: plate crop signed URL, camera id + name +
  location, PTS timestamp, matched watchlist record, `match_type`, edit `distance`, OCR confidence,
  and the combined score
- Fuzzy matches marked visibly as fuzzy, with the distance shown. Never present a fuzzy match as certain.
- Alert lifecycle: `new → ack → dismissed | escalated`, with actor and timestamp
- Live delivery over SSE/WebSocket to the UI
- Rate limiter: a global cap per minute with overflow aggregated into a digest, so a camera storm
  cannot drown the queue

## Acceptance Criteria

- [ ] A seeded watchlist plate appearing on a live feed generates an alert **within 10 s** of the read
- [ ] Dedupe proven: the same vehicle at the same camera 20 times in 5 min yields **one** alert with
      an updated last-seen and a sighting count
- [ ] The same vehicle at a *different* camera yields a **new** alert (dedupe is camera-scoped)
- [ ] Severity assigned from category; config change alters it with no code change
- [ ] Every alert carries a complete "why" payload — a test asserts no field is null
- [ ] Fuzzy-matched alerts are flagged with their distance
- [ ] Lifecycle transitions enforced (cannot ack a dismissed alert); every transition audited
- [ ] Rate limiter proven: inject 500 alerts/min, confirm the cap holds and overflow is digested,
      not dropped silently
- [ ] Expired watchlist entries generate no alerts

## Deliverables

- `packages/api/src/services/alerts.ts` + `config/alert-policy.json`
- SSE endpoint `GET /api/v1/alerts/stream`
- `docs/alerting.md` — dedupe strategy, severity model, rate limiting, and the anti-fatigue rationale

## Validation Gate

```bash
npm run test -w packages/api -- alerts
npm run test -w packages/api -- alerts-dedupe
npm run bench:alert-storm      # 500/min cap test
psql $DATABASE_URL -c "select severity, status, count(*) from alerts group by 1,2;"
curl -N localhost:4000/api/v1/alerts/stream   # live events arrive
```

- [ ] Dedupe, storm, and lifecycle tests green
- [ ] End-to-end: seeded plate on a live feed → alert visible in the stream, with the crop

## Handoff → D2-07, D3-04

Publish the alert payload shape. The UI renders it; the audit chain hashes it.
