---
title: "D1-04 · Catalogue ingest: /api/ingest → registry"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "backend", "pillar-1"]
blocked_by: ["D1-02", "D1-03"]
estimate: "1.5h"
---

## Context

The organisers are explicit: **`/api/ingest` is the contract, the URL pattern is not.** Camera IDs
and the camera set can change between now and evaluation day. Our registry must therefore be able to
re-sync from the catalogue at any moment, including live on stage, without duplicating or losing
local enrichment.

## Scope

- Scheduled + on-demand sync job pulling the catalogue
- Tolerant parsing: the payload shape is undocumented, so probe multiple plausible key names and
  fail loudly with the raw payload attached if none match
- Upsert on `(department_id, external_id)`; never delete on absence — mark `status = 'absent'`
- **Preserve local enrichment** (retention_days, department assignment, coverage polygon, notes) —
  a re-sync must not clobber human-entered fields
- Reconcile declared vs measured: store declared values as declared, never as truth
- Emit a sync report: added / updated / went-absent / returned / unchanged

## Acceptance Criteria

- [ ] Full catalogue syncs into `cameras` in one command
- [ ] Re-sync is idempotent: second run reports all-unchanged, zero writes to changed fields
- [ ] Manually enriched fields survive three consecutive re-syncs (explicit test)
- [ ] A camera removed from the catalogue becomes `status='absent'`, is **not** deleted, and flips
      back to `active` when it returns
- [ ] Unknown payload shape produces a clear error with the raw JSON persisted for inspection
- [ ] Sync report persisted and viewable via API
- [ ] Works when the catalogue requires a session cookie

## Deliverables

- `packages/api/src/jobs/catalogue-sync.ts`
- `npm run sync:catalogue` script
- Sync report endpoint `GET /api/v1/sync/reports`

## Validation Gate

```bash
npm run sync:catalogue
psql $DATABASE_URL -c "select count(*), count(distinct external_id) from cameras;"  # equal
npm run sync:catalogue    # idempotent
npm run test -w packages/api -- catalogue-sync
```

- [ ] Camera count matches `recon-out/report.json` row count from D0-01
- [ ] Enrichment-preservation test passes

## Handoff → D1-05

The prober iterates the registry, not the catalogue. Confirm the registry is the single source.
