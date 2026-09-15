---
title: "D4-13 · Production parity: the deployed URL is what judges test, and it is not the system"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "critical", "blocker-risk", "submission", "infra"]
blocked_by: []
estimate: "3h"
---

## Context

Submissions are judged by opening `https://saakshi.up.railway.app`. Until 15 Sep nobody had checked
that the deployed environment holds the same system the local stack does, and an every-table audit
found it does not. Two of the gaps stop a **compulsory** deliverable and two **differentiators** from
running at all — in the one place that gets scored.

The principle this ticket enforces: **production is the system, not a reduced copy of it.** A feature
that works on a laptop and returns zeros on the deployed URL is a feature we do not have.

### The audit, local vs deployed

| Table | Local | Prod (before) | Consequence |
|---|---:|---:|---|
| `road_network` | 540,711 | **0** | Gap analysis — Model 1's compulsory GIS deliverable — could not run |
| `route_segments` measured | 28 of 40 | **0 of 40** | Route reconstruction and cloning detection return zeros |
| `plate_reads` | 200 | 11 | No government ANPR output on the deployed console at all |
| `sightings` in the report window | 14,900 | **4** | `cam04` shows 1 sighting where the run recorded 7,634 |
| `wall_layouts` | 1 | 0 | Minor |
| `identity_sightings` | 41 | 0 | Low — re-ID ships disabled |
| `camera_health_checks` | **0** | 85 | Prod is *ahead*; local is the stale one |

`cameras`, `departments`, `watchlist_entries`, `routes` and `camera_coverage` already matched.
`audit_log` and `export_bundles` are environment-specific and must **not** be copied.

### Already done on 15 Sep, before this ticket existed — record, do not redo

- **`road_network` loaded.** 540,711 ways · 218,137.5 km, identical to local. Loaded with
  `\copy … to stdout | \copy … from stdin` and explicit column lists, indexes dropped first and
  recreated after: **43 s**. `npm run report:gap-analysis` against production then reproduced every
  published figure — 21.4712 km all-camera, 0.0000 km trusted, 6,750 of 6,750 junctions,
  reconciliation error 0.000000 m.
- **The four government plate reads and their crops.** `plate_read_id`s preserved so
  `submission/govt-feed-output-report.csv` stays traceable; `camera_id` remapped because the two
  databases generated different uuids for the same `external_id`. Crops verified serving through
  `/api/v1/evidence/crop` → `200, image/jpeg`.

## Scope — what is left

### 1 · OSRM is not deployed, so two differentiators are dead in production

Railway runs `api · db · minio · valkey · web`. There is **no `osrm` service**, and `OSRM_URL` is
unset on `api`, so it falls back to the code default `http://localhost:5000` — inside the container.
Loading the road graph was necessary and not sufficient: the routing engine is separate.

A judge running a trace on the deployed console today sees **`0.0 km observed · 0.0 km inferred ·
"Not drawn · 10" · 0 of 10 transitions assessable`**. The 9.24 km / 30 s / **1,109 km/h** cloned-plate
finding cannot be reproduced there, and it is a headline claim in the deck and the HLD.

Deploy `osrm/osrm-backend` with the Gujarat graph — either the 1.3 GB preprocessed `.osrm*` set on a
volume, or `osrm-extract`/`partition`/`customize` at build time from the 72 MB `data/gujarat-highways.osm.pbf`
— then set `OSRM_URL=http://osrm.railway.internal:5000` and redeploy `api`.

### 2 · The route cache is stale, and `reconstruct=true` does not bust it

`cache.hit: true, builtAt: 2026-09-13T17:02` — built when `road_network` was empty, so every segment
is unmeasured and stays that way no matter what OSRM does afterwards. The API accepts
`reconstruct=true`; **the web UI strips the parameter from the URL**, so an operator cannot force a
rebuild from the console at all. D4-10's handoff warned about this exact shape and it recurred.

Clear the cached segments after OSRM lands, and make the console able to force a rebuild.

### 3 · The 11 September government-feed sighting run is missing

Prod holds 90,704 sightings from a *different* ingest run and **4** in the window the output report
covers. Local holds 14,900 across `cam01` 2,674 / `cam04` 7,634 / `cam05` 4,592.

This is not cosmetic. A report regenerated against production **drops the line disclosing that cam01
saw 2,674 vehicles and read zero plates** — one of the report's most honest statements. Camera uuids
differ between the databases, so a raw `pg_dump` cannot do it; the rows need `camera_id` remapped by
`external_id`, ids preserved, `ON CONFLICT (id, ts) DO NOTHING` (`sightings` is a TimescaleDB
hypertable, so its primary key is `(id, ts)`).

### 4 · The gap-analysis generator hardcodes its explanation and contradicts its own table

Run against production it printed *"The cause is measured and specific: **0 of 85** cameras have never
had a health check run against them, so every one resolves to `band: null`"* — directly above a table
reading `dead 55 · trusted 26 · degraded 3 · untrusted 1`. Both cannot be true.

The figures are right; the reasoning is asserted rather than derived. The real cause of 0.00 km
trusted coverage in production is different and more interesting: **26 cameras are trusted and not one
of them has coordinates.** Derive the sentence from the band/placement split.

### Out of scope

The 185 own-feed `plate_reads`, `wall_layouts` and `identity_sightings`. Log them; they change
nothing a judge is scored on. **Never** copy `audit_log` or `export_bundles` — an audit chain is
environment-specific by construction and copying one destroys its meaning.

## Acceptance Criteria

- [ ] An `osrm` service runs in the Railway project and answers a route query on the private network
- [ ] `OSRM_URL` on `api` names that service; **no deployed service resolves a dependency to
      `localhost`** — proven by reading the variable, not by assumption
- [ ] A trace of `GJ01AB1234` on the **deployed console** draws a route with OBSERVED solid and
      INFERRED dashed, and reports non-zero observed kilometres
- [ ] The **1,109 km/h** impossible transition is reported on the deployed console, and is labelled
      synthetic exactly as the local tool labels it
- [ ] `route_segments` in production has the same measured count as local (**28 of 40**), or the
      difference is explained by a stated cause
- [ ] The government-feed sighting window is present in production: `cam01` 2,674 · `cam04` 7,634 ·
      `cam05` 4,592
- [ ] `npm run report:anpr-output` against production regenerates
      `submission/govt-feed-output-report.csv` **identical to the committed file** on every column
      except `camera_id`, and the PDF still names the cameras that saw vehicles and read no plate
- [ ] `npm run report:gap-analysis` against production reproduces 21.4712 km / 0.0000 km /
      6,750 of 6,750, and its prose no longer contradicts its own band table
- [ ] `npm run check:links` against the deployed console stays at **0 broken**
- [ ] `npm run test && npm run typecheck && npm run lint` green, and no migration script is left in
      the repo root as a dotfile — anything worth keeping lands in `scripts/` with a doc comment

## Deliverables

- An `osrm` service definition committed (Dockerfile / `railway.json`), not configured by hand only
- `scripts/promote-run-to-environment.ts` — the camera-id-remapping migration, idempotent, with a
  `--dry-run`
- The gap-analysis generator deriving its explanation from the data
- `docs/deployment.md` § production parity: what must be true of a deployed environment, and the
  command that proves each one

## Validation Gate

```bash
# every check runs against the DEPLOYED system, which is the entire point of this ticket
npm run check:links -- --base https://saakshi.up.railway.app --api https://saakshi-api.up.railway.app
DATABASE_URL="$PROD_DATABASE_URL" npm run report:gap-analysis
DATABASE_URL="$PROD_DATABASE_URL" npm run report:anpr-output -- --from 2026-09-11T00:00:00Z --to 2026-09-12T00:00:00Z
git diff --exit-code submission/govt-feed-output-report.csv   # only camera_id may differ; see AC
npm run test && npm run typecheck && npm run lint
```

- [ ] A trace on the deployed console, screenshotted, showing a drawn route and the impossible
      transition — the evidence for the two ACs a command cannot check

## Handoff → D4-03, D4-SUBMIT

**D4-03's recording depends on this.** Sections 3 and 5 of `demo-video/DEMO_SCRIPT.md` cannot be shot
truthfully against production until items 1–3 land: the narration states sighting volumes and a route
reconstruction that production currently cannot show. Record after this ticket closes, or record
those two sections against local and say so on the ticket.
