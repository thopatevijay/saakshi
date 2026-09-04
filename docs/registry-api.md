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
_Populated by `npm run bench:api` — see the results table committed below._
<!-- BENCHMARK:END -->

### What the numbers mean

- **p95** is reported per scenario. The stated target is **< 200 ms**.
- **500 concurrent connections** is the stated concurrency target; `non-2xx` and `errors` must both
  be zero, since throughput at the cost of failed requests is not throughput.
- **Deep cursor page** exists to prove the pagination claim: its p95 sits with the first page's
  rather than degrading, which is what keyset pagination buys over `OFFSET`.
- Measured on the development machine (Apple Silicon, Postgres in Docker). A deployed instance with
  the database on the same host network should do better; these are the honest local numbers, not a
  projection.

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
