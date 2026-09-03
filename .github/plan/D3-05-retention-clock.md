---
title: "D3-05 · Retention / evidence clock"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "backend", "frontend", "pillar-4", "differentiator", "high-value"]
blocked_by: ["D1-06"]
estimate: "2.5h"
---

## Context

**The most departmentally useful feature in the whole build, and nearly free.**

The problem statement states retention is *"7 days ... others for 15 days or more"* and varies by
department. So evidence silently expires. Report a crime on day 12 and **nobody in Gujarat can tell
you what footage still exists.** An investigating officer's most urgent question is "what can I still
get, and how long do I have?" — and today there is no way to answer it.

## Scope

- Given a location + radius + time window: which cameras covered it, and for each — is that footage
  **still within retention**, and when does it expire
- Countdown per camera: days/hours remaining, derived from `cameras.retention_days` per department
- Three states: `available` · `expiring soon` (configurable threshold, default 48 h) · `expired`
- **Preservation request** workflow: officer flags footage to preserve → request recorded with case
  reference → audited → appears on a preservation queue. (We cannot actually extend a department's
  retention; we generate the actionable request and record it. **Be explicit about that limit.**)
- Surfaced in three places: the alert detail ("this evidence expires in N days"), the trace view
  (per sighting), and a standalone "evidence availability" search
- Estate-wide view: how much of the estate is on 7-day vs 15-day vs longer retention, by department

## Acceptance Criteria

- [ ] Location+time query returns covering cameras with correct retention state
- [ ] Countdown arithmetic correct across day boundaries and DST-free IST; boundary tests present
- [ ] Cameras with unknown `retention_days` reported as **unknown**, never assumed
- [ ] `expiring soon` threshold configurable
- [ ] Preservation request records case reference, is audited, and appears on the queue
- [ ] The UI states plainly that a preservation request is an *instruction to the owning department*,
      not an automatic retention extension
- [ ] Retention state shown in alert detail and trace views
- [ ] Estate-wide retention distribution matches a hand-checked SQL count

## Deliverables

- `packages/api/src/services/retention.ts`
- `packages/web/app/evidence/*` + retention badges in alert and trace views
- `docs/retention-model.md` — the model, the honest limits, and what the department must do

## Validation Gate

```bash
npm run test -w packages/api -- retention
curl -fsS "localhost:4000/api/v1/evidence/availability?lat=23.2&lon=72.6&radius_m=500&at=2026-09-01T14:00:00Z" | jq
psql $DATABASE_URL -c "select retention_days, count(*) from cameras group by 1 order by 1;"
```

- [ ] Boundary tests green
- [ ] Unknown-retention cameras reported as unknown
- [ ] Screenshot for the deck

## Handoff → D4-04

Frame this in the deck as an *investigation* feature, not a storage feature. That is how a police
audience will hear it.
