---
title: "D1-02 · Registry API: camera CRUD, bulk import, API onboarding"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "backend", "pillar-1", "model-1-deliverable"]
blocked_by: ["D1-01"]
estimate: "3h"
---

## Context

**Model 1 is compulsory and names three onboarding paths explicitly: bulk import, manual entry, and
API.** All three must be demonstrable — this is a scored deliverable, not an internal detail.

## Scope

Fastify + zod. Endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/cameras` | list; filters: department, district, type, mount, adapter, status, trust range, bbox |
| GET | `/api/v1/cameras/:id` | detail incl. latest health + trust breakdown |
| POST | `/api/v1/cameras` | manual single onboarding |
| PATCH | `/api/v1/cameras/:id` | update metadata |
| DELETE | `/api/v1/cameras/:id` | soft delete (never hard) |
| POST | `/api/v1/cameras/bulk` | CSV **and** JSON bulk import, row-level validation report |
| POST | `/api/v1/cameras/onboard-from-catalogue` | pull `/api/ingest` and upsert (D1-04 uses this) |
| GET | `/api/v1/cameras/export` | CSV/JSON export — Model 1 "sample metadata dataset" deliverable |
| GET | `/api/v1/departments` | list |

Rules:
- Every list endpoint paginates (cursor) and is bbox-queryable via PostGIS
- Bulk import is **transactional per batch** with a per-row error report; it never half-applies
- Upsert keyed on `(department_id, external_id)` — re-running the catalogue import must not duplicate
- Every mutating call writes to `audit_log` (chain lands in D3-04; write the rows now)
- RBAC: `operator` read-only; `supervisor` create/update; `admin` delete

## Acceptance Criteria

- [ ] All nine endpoints implemented, zod-validated on input **and** output
- [ ] OpenAPI spec auto-generated and served at `/api/v1/docs`
- [ ] Bulk CSV import of ≥50 rows succeeds; a file with 3 deliberately bad rows returns
      47 imported + 3 row-level errors and **commits nothing partial**
- [ ] Re-running the same bulk import produces zero duplicates
- [ ] bbox filter returns only cameras inside the box (PostGIS-verified)
- [ ] RBAC enforced and covered by tests for all three roles
- [ ] Every mutation produces an `audit_log` row
- [ ] Integration tests cover happy path + validation failure + RBAC denial for each endpoint

## Deliverables

- `packages/api/src/routes/cameras.ts`, `departments.ts`
- `docs/registry-api.md` — **Model 1 named deliverable**: prose + the OpenAPI spec
- `fixtures/cameras-bulk-sample.csv` — the 50-row demo import used on stage
- `fixtures/cameras-bulk-invalid.csv` — the 3-bad-row file, for the validation demo

## Validation Gate

```bash
npm run test -w packages/api -- cameras
curl -fsS localhost:4000/api/v1/docs | head -c 200
curl -fsS -XPOST localhost:4000/api/v1/cameras/bulk -F file=@fixtures/cameras-bulk-sample.csv
curl -fsS -XPOST localhost:4000/api/v1/cameras/bulk -F file=@fixtures/cameras-bulk-sample.csv  # no dupes
curl -fsS "localhost:4000/api/v1/cameras?bbox=72.4,23.0,72.8,23.4" | jq '.data|length'
psql $DATABASE_URL -c "select count(*) from audit_log;"   # > 0
```

- [ ] All commands succeed; duplicate check proves idempotency
- [ ] `docs/registry-api.md` is complete enough for a third party to onboard a camera without asking

## Handoff → D1-04, D1-08

Publish the final query-param contract as a comment; the map UI builds directly against it.
