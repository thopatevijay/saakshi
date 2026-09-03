---
title: "D2-07 · Alert queue UI: verify in three seconds"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "frontend", "pillar-4"]
blocked_by: ["D2-06", "D1-07"]
estimate: "3h"
---

## Context

This is the screen a constable stares at during a shift, and the screen a judge will judge. The
design brief is one sentence: **an officer must be able to confirm or dismiss an alert in three
seconds without leaving the row.**

## Scope

- Live queue over SSE, newest first, severity-coloured, with an unobtrusive new-alert indicator
  (no layout jump, no modal stealing focus)
- Each row shows, inline and without a click: **plate crop thumbnail**, read text, camera name +
  location, timestamp, watchlist category, match type + distance, confidence
- Row expand → full evidence: full frame, matched watchlist record, camera detail link,
  "trace this vehicle" action (into D2-08)
- One-click `Acknowledge` / `Dismiss` / `Escalate`; dismiss requires a reason
- Filters: severity · category · camera · department · time range · match type · status
- Fuzzy matches visually distinct from exact, with distance shown — the UI must never imply
  certainty the data does not support
- Keyboard-first: `j/k` navigate, `a` ack, `d` dismiss, `e` escalate, `enter` expand
- Digest row when the rate limiter aggregates an overflow burst

## Acceptance Criteria

- [ ] New alerts appear live without a refresh and without shifting the row under the cursor
- [ ] Crop thumbnail renders from the signed URL; a broken/expired URL degrades gracefully
- [ ] **Three-second test**: a stopwatch run confirms plate, camera, time, category and confidence
      are all legible without any click — recorded in the ticket
- [ ] Ack/dismiss/escalate work optimistically with rollback on server error
- [ ] Dismiss without a reason is blocked
- [ ] All filters compose and persist in the URL
- [ ] Fuzzy vs exact visually unmistakable
- [ ] Full keyboard operation with a visible focus ring; accessibility ≥ 90
- [ ] 500 alerts render without jank (virtualised list)

## Deliverables

- `packages/web/app/alerts/*`
- `docs/screenshots/alerts-queue.png` for the deck
- A short screen recording of the live alert arriving (raw material for the demo video)

## Validation Gate

```bash
npm run test -w packages/web -- alerts
npm run build -w packages/web
npm run bench:alert-ui      # 500-row render, no dropped frames
```

- [ ] Manual three-second test recorded
- [ ] Manual keyboard-only run through ack/dismiss/escalate
- [ ] Screenshot + recording captured

## Handoff → D4-03

This screen is the emotional centre of the demo video. Capture clean footage now, while feeds are known good.
