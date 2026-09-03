---
title: "D1-01 · Database schema and migrations"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "backend", "data", "pillar-1"]
blocked_by: ["D0-03"]
estimate: "2h"
---

## Context

Every later ticket writes to this schema. It is defined in `PROJECT.md §8` — implement it exactly,
and treat deviations as schema changes that need a migration, not edits.

Two tables are Timescale hypertables because they are append-heavy time series:
`camera_health_checks` and `sightings`.

## Scope

Migrations (drizzle-kit) for all tables in `PROJECT.md §8`:

`departments · users · cameras · camera_health_checks* · camera_coverage · road_network ·
sightings* · plate_reads · vehicle_identities · identity_sightings · watchlist_entries · alerts ·
routes · route_segments · audit_log · export_bundles · onboarding_responses`

(* = hypertable)

Required specifics:
- PostGIS: `cameras.location geography(Point,4326)`, `camera_coverage.fov_polygon geography`,
  `road_network.geom geography(LineString)`, `route_segments.path geography(LineString)`
- GiST indexes on every geography column
- Timescale: `create_hypertable` on `camera_health_checks(checked_at)` and `sightings(ts)`
- `sightings`: composite index `(camera_id, ts desc)` and index on `track_id`
- `plate_reads.normalized_text`: **trigram index** (`pg_trgm`) — the fuzzy search in D2-05 depends on it
- `alerts.dedupe_key`: unique index scoped to the dedupe window
- `audit_log`: `prev_hash`/`hash` non-null, and an append-only guard (revoke UPDATE/DELETE from the
  app role)
- Enum types (not free text) for: `camera_type`, `mount`, `storage_type`, `adapter_kind`,
  `watchlist_entries.category`, `entity_type`, `source_system`, `alerts.status`, `match_type`,
  `route_segments.anomaly`, `users.role`
- Seed: departments (Health, Police, GSRTC, Panchayat, Municipal) and four users, one per role

## Out of scope

- Road network *data* import (D3-01) — table only
- Any API surface (D1-02)

## Acceptance Criteria

- [ ] `npm run db:migrate` applies cleanly to an empty database
- [ ] `npm run db:migrate` is idempotent — running twice is a no-op, not an error
- [ ] Rollback path exists and is tested (`db:rollback` returns to the prior state)
- [ ] Both hypertables confirmed via `timescaledb_information.hypertables`
- [ ] `pg_trgm` and `postgis` extensions created by migration, not manually
- [ ] Append-only guard on `audit_log` proven: an `UPDATE` as the app role raises an error
- [ ] Seed data loads: 5 departments, 4 users covering `admin/supervisor/operator/auditor`
- [ ] Drizzle types generated into `packages/shared` and consumed by `packages/api` with no `any`

## Deliverables

- `db/migrations/*` — versioned, reversible
- `packages/shared/src/db-types.ts` — generated types
- `docs/data-model.md` — table-by-table purpose + the ER diagram (source for the HLD)

## Validation Gate

```bash
npm run db:reset && npm run db:migrate && npm run db:migrate   # twice = idempotent
psql $DATABASE_URL -c "select hypertable_name from timescaledb_information.hypertables;"
psql $DATABASE_URL -c "select count(*) from departments;"       # = 5
psql $DATABASE_URL -c "select count(*) from users;"             # = 4
psql $DATABASE_URL -c "select extname from pg_extension where extname in ('postgis','pg_trgm','timescaledb');"
npm run typecheck
```

- [ ] All commands pass; append-only guard test passes
- [ ] `docs/data-model.md` diagram renders

## Handoff → D1-02, D1-05, D2-01

Publish the final enum values as a comment on this issue; workers and API must not invent variants.
