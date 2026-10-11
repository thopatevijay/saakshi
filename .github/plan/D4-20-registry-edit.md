---
title: "D4-20 · The registry Edit button is a stub"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4","frontend","demo-critical"]
blocked_by: []
estimate: "2h"
---

## Context
`registry-table.tsx`'s **Edit** button only shows *"Editing … lands with the onboarding workflow ticket."* `PATCH /api/v1/cameras/:id` already exists (admin/supervisor) and accepts lat/lon. A judge clicking Edit sees a stub.

## Scope
An edit dialog for one camera, reusing the manual-add dialog's fields and validation: name, latitude/longitude, address, district, camera type, mount, geometry class, adapter, vendor, VMS, retention days, storage type. Saved with `PATCH`. Admin/supervisor only (operators see no Edit). The change is written to the audit chain (add a `camera.update` entry if `PATCH` doesn't write one). After saving, the map/table reflect it without a full reload.

## Acceptance Criteria
- [ ] Editing a tray camera's lat/lon moves it onto the map (browser evidence: screenshot)
- [ ] Operators don't see Edit; the API refuses an operator `PATCH` (403), proven by test
- [ ] Each successful edit writes one audit-chain entry with actor and changed fields; `npm run audit:verify` still passes
- [ ] Validation errors (bad lat/lon, retention < 0) show inline, nothing is saved
- [ ] typecheck, lint and affected tests green
