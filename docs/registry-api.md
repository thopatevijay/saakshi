# SAAKSHI Registry API

**Model 1 named deliverable.** Reference Model 1 requires three onboarding paths — **bulk import,
manual entry, and API** — and all three are served here. This document is written so a third party
can onboard a camera without asking anyone a question.

Live OpenAPI spec: **`GET /api/v1/docs`** (browsable) · **`GET /api/v1/docs/json`** (machine-readable).
The spec is generated from the same zod schemas the server validates with, so it cannot describe
behaviour the server does not have.

---

## 1 · Authentication

Every endpoint except `/health` requires a bearer token.

```
Authorization: Bearer <JWT>
```

The token is an HS256 JWT signed with `JWT_SECRET`, carrying:

```json
{
  "sub": "<user uuid>",
  "badgeNo": "GP-OPR-1042",
  "role": "operator",
  "departmentId": null
}
```

`401` means the credential is missing, malformed or expired — log in again. `403` means the
credential is valid but the role may not do this. They are deliberately different answers.

> Token *issuance* is D1-07's web-side login. This API only verifies.

### Role matrix

| Role | Read | Create / update / import | Delete |
|---|---|---|---|
| `admin` | ✅ | ✅ | ✅ |
| `supervisor` | ✅ | ✅ | ❌ |
| `operator` | ✅ | ❌ | ❌ |
| `auditor` | ✅ | ❌ | ❌ |

`operator` is the control-room seat and is read-only on the registry. `auditor` is read-only *by
design*: an auditor who can change the thing being audited is not an auditor.

---

## 2 · Endpoints

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/v1/cameras` | read | List with filters, cursor pagination, PostGIS bbox |
| GET | `/api/v1/cameras/:id` | read | Detail incl. latest health and declared-vs-measured |
| POST | `/api/v1/cameras` | write | **Manual onboarding** (one camera) |
| PATCH | `/api/v1/cameras/:id` | write | Update metadata |
| DELETE | `/api/v1/cameras/:id` | admin | **Soft** delete |
| POST | `/api/v1/cameras/bulk` | write | **Bulk import** — CSV or JSON, per-row report |
| POST | `/api/v1/cameras/onboard-from-catalogue` | write | **API onboarding** — pull upstream and upsert |
| GET | `/api/v1/cameras/export` | read | CSV/JSON export (Model 1 sample metadata dataset) |
| GET | `/api/v1/departments` | read | Departments with live camera counts |

---

## 3 · `GET /api/v1/cameras` — the query contract

**This section is the contract D1-08's map builds against.** Parameter names and semantics are
stable.

| Parameter | Type | Notes |
|---|---|---|
| `departmentId` | uuid | Owning department |
| `district` | string | Exact match |
| `cameraType` | `analog` \| `ip` | |
| `mount` | `static` \| `mobile` | |
| `adapterKind` | `hls` \| `rtsp` \| `onvif` \| `whep` \| `nvr` \| `file` | |
| `status` | `unknown` \| `online` \| `degraded` \| `offline` | |
| `geometryClass` | `anpr_viable` \| `detection_only` \| `unclassified` | Set by human review |
| `trustMin` / `trustMax` | 0–100 | Cameras never probed have `trustScore: null` and match **neither** bound |
| `bbox` | `minLon,minLat,maxLon,maxLat` | **Longitude first** — GeoJSON/MapLibre order, so a viewport passes straight through |
| `q` | string | Case-insensitive substring over name, externalId, address |
| `limit` | 1–500, default 50 | |
| `cursor` | opaque | Round-trip it; never construct it |

Filters combine with AND. Soft-deleted cameras are invisible to every read path.

### Response

```json
{
  "data": [ { "id": "…", "externalId": "cam09", "…": "…" } ],
  "nextCursor": "eyJvbmJvYXJkZWRBdCI6…",
  "limit": 50
}
```

`nextCursor` is `null` on the last page. Pagination is **keyset**, ordered by
`(onboarded_at, id)` — not `OFFSET`, which at 100k rows makes the database walk and discard
90,000 rows to serve page 1,800. A keyset cursor is flat regardless of depth, which the benchmark
below demonstrates.

### bbox is real PostGIS

```
GET /api/v1/cameras?bbox=72.4,23.0,72.8,23.4
```

compiles to `ST_Intersects(location, ST_MakeEnvelope(72.4, 23.0, 72.8, 23.4, 4326)::geography)`
against the GiST index on `cameras.location`.

---

## 4 · Camera detail: declared vs measured

`GET /api/v1/cameras/:id` returns the camera plus:

```json
{
  "latestHealth": {
    "checkedAt": "2026-09-04T08:12:00.000Z",
    "connectable": true,
    "decodable": true,
    "measuredFps": 10.0,
    "actualResolution": "854x480",
    "actualCodec": "h264",
    "nightUsable": false,
    "ptsDriftMs": 120,
    "trustScore": 61.5,
    "breakdown": { "fps": 0.4, "resolution": 0.25 }
  },
  "declaredVsMeasured": {
    "fpsDeclared": 25,   "fpsMeasured": 10,      "fpsDelta": -15,
    "resolutionDeclared": "1920x1080", "resolutionMeasured": "854x480", "resolutionMatches": false,
    "codecDeclared": "h264", "codecMeasured": "h264", "codecMatches": true
  }
}
```

**This block is the product, not a diagnostic.** A department that declared 25 fps at 1080p on a
camera actually delivering 10 fps at 480p is exactly the "we don't know what we have" problem
Model 1 exists to solve. Both fields are `null` until the prober (D1-05) has run at least once —
and `trustScore: null` means *never measured*, which is not the same as scored zero. The UI must
show the difference.

---

## 5 · Onboarding path 1 — manual entry

```bash
curl -fsS -XPOST localhost:4000/api/v1/cameras \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "externalId": "cam09",
    "name": "New Bypass 66KV FIX-2, Junagadh",
    "adapterKind": "hls",
    "lat": 21.4956, "lon": 70.4402,
    "district": "Junagadh",
    "declaredCodec": "h264", "declaredFps": 25, "declaredResolution": "1920x1080",
    "geometryClass": "anpr_viable",
    "endpoints": { "hls": "https://<host>/cam09/index.m3u8" }
  }'
```

`201` with the created camera. `409` if that `externalId` already exists **for that department**.
`400` with field-level detail otherwise:

```json
{
  "error": "validation_failed",
  "message": "request did not match the schema",
  "details": [ { "field": "declaredResolution", "message": "expected WIDTHxHEIGHT, e.g. 1920x1080" } ]
}
```

Only `externalId`, `name` and `adapterKind` are required. Everything else is optional because a
department that does not know its own camera's codec should still be able to register it — the
registry's job is to find that out, not to demand it up front.

---

## 6 · Onboarding path 2 — bulk import

```bash
curl -fsS -XPOST localhost:4000/api/v1/cameras/bulk \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@fixtures/cameras-bulk-sample.csv
```

CSV header (also the export column order, so an export round-trips as an import):

```
externalId,name,departmentId,lat,lon,address,district,cameraType,mount,geometryClass,
declaredCodec,declaredFps,declaredResolution,vendor,vmsPlatform,retentionDays,storageType,adapterKind
```

JSON is accepted on the same endpoint — either a bare array or `{ "cameras": [...] }` — which is
the programmatic path for a department with its own system:

```bash
curl -fsS -XPOST localhost:4000/api/v1/cameras/bulk \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cameras":[{"externalId":"cam09","name":"…","adapterKind":"hls"}]}'
```

### The report

```json
{
  "received": 50,
  "imported": 47,
  "created": 47,
  "updated": 0,
  "format": "csv",
  "committed": true,
  "rejected": [
    { "row": 7,  "externalId": "GJ-AHM-0007", "errors": [{ "field": "declaredFps", "message": "Invalid input: expected number, received string" }] },
    { "row": 19, "externalId": "GJ-GAN-0019", "errors": [{ "field": "adapterKind", "message": "Invalid option: expected one of \"hls\"|\"rtsp\"|\"onvif\"|\"whep\"|\"nvr\"|\"file\"" }] },
    { "row": 33, "externalId": null,          "errors": [{ "field": "externalId", "message": "Too small: expected string to have >=1 characters" }] }
  ]
}
```

Three guarantees:

1. **Nothing partial.** The valid rows are written in **one transaction**, so a failure part-way
   through leaves the registry exactly as it was. There is no state in which half a batch landed.
2. **Every bad row is reported in one pass**, with the field and the reason. An operator importing
   500 cameras gets the whole list at once, not one error per re-upload.
3. **Re-running is safe.** Rows upsert on `(department_id, external_id)`, so importing the same file
   twice reports `created: 0, updated: 50` and adds nothing. A camera's *measured* `trustScore` and
   `status` are never touched by a metadata re-import.

`row` is 1-based over data rows, matching what a spreadsheet shows. A file listing the same camera
twice is a row error, not a failure.

Demo fixtures: `fixtures/cameras-bulk-sample.csv` (50 valid rows) and
`fixtures/cameras-bulk-invalid.csv` (the same 50 with rows 7, 19 and 33 broken three different ways).

---

## 7 · Onboarding path 3 — API / catalogue pull

```bash
curl -fsS -XPOST localhost:4000/api/v1/cameras/onboard-from-catalogue \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"adapterKind":"hls"}'
```

Reads `SENTINEL_INGEST_URL`, falling back to `https://$SENTINEL_HOST/cameras.json`, and upserts
every entry. **`GET /api/ingest` is the contract; the URL pattern is not** — it is configuration, so
a changed upstream shape is an env edit rather than a code change.

Accepts `[{id,name}]` or `{cameras:[{id,name}]}`. The deployed sandbox returns only `id` and `name`
— no codec, no fps, no live status, whatever the Integrator's Guide says — and every field beyond
those two stays `null` rather than being invented. `502` on an unreachable or unrecognised upstream.

Idempotent: run it twice and the second call reports `created: 0`.

---

## 8 · Export — Model 1 sample metadata dataset

```bash
curl -fsS "localhost:4000/api/v1/cameras/export?format=csv" -H "Authorization: Bearer $TOKEN"
curl -fsS "localhost:4000/api/v1/cameras/export?format=json" -H "Authorization: Bearer $TOKEN"
```

Optional `departmentId` scopes it to one department. The CSV column order is identical to the bulk
import header, which is the point: hand a department their own data back, let them correct it in a
spreadsheet, and take the same file as an import.

---

## 9 · Soft delete

`DELETE /api/v1/cameras/:id` (admin only) sets `deleted_at`. The row is never removed, because it
remains the provenance of every sighting and alert already attached to it. The camera disappears
from every read path immediately; `GET /api/v1/cameras/:id` then returns `404`.

---

## 10 · Audit trail

**Every mutating call writes a row to `audit_log`** — create, update, delete, bulk import, catalogue
onboarding, and export. Each row records the actor, the action, the target, a mandatory `purpose`,
an optional `case_ref`, the result count, and `prev_hash`/`hash` linking it to its predecessor.

Only field *names* are recorded for an update, never values: an audit row is not the place to copy
the payload.

The table is append-only in the database — `saakshi_app` holds SELECT and INSERT only, and BEFORE
UPDATE/DELETE triggers raise `restrict_violation` even for the owner. Chain verification and export
bundles are D3-04.

---

## 11 · Measured performance

Run it yourself:

```bash
make up && make migrate
npm run bench:api                    # seeds to 100k cameras, then measures
BENCH_ROWS=250000 npm run bench:api  # bigger
```

<!-- BENCHMARK:START -->
### Environment

Apple Silicon MacBook Air, PostgreSQL 16.14 in Docker, API and load generator on the same host, a
**single Node process** (one core). 10 s per scenario, autocannon. These are honest local numbers,
not a projection — a deployed instance with a dedicated database and more than one API process will
do better.

Run-to-run variance is real on a laptop that is also running the database and the build: identical
code produced 238 ms, 345 ms and 837 ms for the same scenario across runs. The table below is one
complete clean run; treat the shape as the finding, not the third significant figure.

### Registry size: 1,00,000 cameras · 500 concurrent connections · zero failed responses

| Scenario | Conns | Requests | req/s | p50 | p95 | p99 | max | non-2xx | errors |
|---|---|---|---|---|---|---|---|---|---|
| health | 500 | 5,11,445 | 51,152 | 9 ms | **13 ms** | 13 ms | 1303 ms | 0 | 0 |
| list (50) | 500 | 22,544 | 2,255 | 211 ms | **345 ms** | 1354 ms | 2940 ms | 0 | 0 |
| list (500) | 100 | 3,594 | 359 | 277 ms | **317 ms** | 435 ms | 1587 ms | 0 | 0 |
| bbox (Ahmedabad) | 500 | 15,523 | 1,552 | 301 ms | **439 ms** | 1201 ms | 2371 ms | 0 | 0 |
| filtered (adapter+trust) | 500 | 20,389 | 2,039 | 234 ms | **269 ms** | 979 ms | 2689 ms | 0 | 0 |
| departments | 500 | 83,622 | 8,363 | 56 ms | **74 ms** | 84 ms | 729 ms | 0 | 0 |
| deep cursor page | 500 | 21,488 | 2,150 | 225 ms | **265 ms** | 1217 ms | 3011 ms | 0 | 0 |

**500+ concurrent users without degradation: PASS.** 500 connections, seven scenarios,
**zero non-2xx and zero errors**. Throughput holds flat rather than collapsing.

**1,00,000+ records without pagination degradation: PASS.** The `deep cursor page` scenario
(**265 ms**) is *faster* than the first page (345 ms) — a keyset cursor costs the same at row 90,000
as at row 1. `OFFSET 90000` would have walked and discarded 90,000 rows to serve that page.

### p95 vs concurrency — the number quoted with its load

| Concurrent clients | p95 | req/s | failed |
|---|---|---|---|
| 10 | **7 ms** | 2,159 | 0 |
| 25 | **14 ms** | 2,408 | 0 |
| 50 | **25 ms** | 2,397 | 0 |
| 100 | **51 ms** | 2,358 | 0 |
| 200 | **110 ms** | 2,159 | 0 |
| 500 | **252 ms** | 2,124 | 0 |

**p95 < 200 ms holds up to 200 concurrent clients per API instance** (110 ms measured). Beyond that
a single instance saturates.

This is queueing, not slowness, and the arithmetic says so. Throughput is flat at ~2,200 req/s
across the whole sweep while p95 rises linearly with concurrency — the signature of a saturated
server, where added load becomes queue wait. Little's Law: 500 concurrent ÷ 2,255 req/s ≈ 222 ms,
against a measured p50 of 211 ms.

The bottleneck is **Node's single core, not PostgreSQL**:

- raw query execution is **0.96 ms** (`EXPLAIN ANALYZE`, planning 1.7 ms);
- `/health` sustains **51,152 req/s** on the same process, so the runtime is not the limit for
  trivial work;
- raising `DATABASE_POOL_MAX` from 20 to 50 moved p95 by ~5% — if the database were the constraint
  it would have moved a great deal more.

**So the answer to more than 200 concurrent operators is more API instances, not a faster query.**
The API is stateless; every instance shares the same Postgres. Sizing arithmetic for the deployment
is in D3-08's calculator.

### What made it this fast

Two fixes, both found by measuring rather than reading:

1. **An index on the pagination sort key** (`0011_registry_pagination_index`). Without it, ordering
   by `(onboarded_at, id)` made Postgres `Parallel Seq Scan` all 100,000 rows and top-N sort them to
   return fifty — *on every page request*. Worst p95 was **9,839 ms with 266 failed requests**.
   Buffers per request fell from 2,497 to 54.
2. **Removing double response validation.** Handlers parsed each row against `CameraResponse` and
   the serializer then validated the same rows against the same schema. Output is still fully
   zod-validated — once, in the serializer.

### A trap worth knowing

`npm run bench:api` refuses to run without connection headroom:

```
not enough connection headroom (152 in use of 300, need 50). An interrupted run probably
leaked its pool: `docker compose restart db` and try again.
```

An interrupted benchmark leaves its pool open. Once `max_connections` is exhausted the API returns
`500`s that look exactly like application failures — one polluted run reported **27,180 "failed
responses"** that were connection exhaustion, not a defect. `max_connections=300` in
`docker-compose.yml` and this guard exist so that number cannot be published by accident.
<!-- BENCHMARK:END -->

---

## 12 · Error shapes

| Status | `error` | Meaning |
|---|---|---|
| 400 | `validation_failed` | Request did not match the schema. `details[]` names each field |
| 400 | `bad_request` | Malformed body, unparseable CSV/JSON |
| 401 | `unauthorized` | Missing, malformed or expired bearer token |
| 403 | `forbidden` | Valid token, insufficient role. `allowed[]` lists roles that may |
| 404 | `not_found` | No such camera (or it is soft-deleted) |
| 409 | `conflict` | `externalId` already exists for that department |
| 502 | `bad_gateway` | Upstream catalogue unreachable or unrecognised |

---

## 13 · Enum values

The contract, mirrored from `db/migrations/0002_enums.up.sql`. Postgres rejects anything else, so
these are enforced rather than documented.

| Field | Values |
|---|---|
| `adapterKind` | `hls` `rtsp` `onvif` `whep` `nvr` `file` |
| `cameraType` | `analog` `ip` |
| `mount` | `static` `mobile` |
| `storageType` | `cloud` `local` |
| `status` | `unknown` `online` `degraded` `offline` |
| `geometryClass` | `anpr_viable` `detection_only` `unclassified` |
| `role` | `admin` `supervisor` `operator` `auditor` |
