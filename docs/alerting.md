# Alerting — dedupe, severity, rate limiting, and why any of it matters

**D2-06.** Engine: `packages/api/src/services/alerts.ts`. Policy: `config/alert-policy.json`.
Migration: `db/migrations/0016_alert_engine.up.sql`. Tests: `packages/api/src/services/alerts.test.ts`
and `alerts-dedupe.test.ts`. Benchmark: `npm run bench:alert-storm`.

---

## 1 · The premise

**The real failure mode of an alert system is fatigue, not accuracy.**

An estate of 80,000 cameras with naive alerting produces a firehose. A firehose gets switched off,
and once it is off the accuracy of the detector is irrelevant, because nobody is reading it. This is
not a hypothetical: it is the reason control rooms end up with a wall of screens nobody watches.

The design constraint that follows is a hard one:

> **If an officer cannot verify an alert in three seconds, it is noise.**

Three seconds is enough to look at a crop, read a plate, see a camera name and decide. It is not
enough to open another system, run a query, or ask somebody. So the alert carries its own evidence
and its own reasoning, and it says out loud where it is unsure.

Three mechanisms exist for that and no other reason: **dedupe** (§3), **severity that identification
quality can only lower** (§4), and **a delivery cap with a digest** (§5).

---

## 2 · The path a read takes

```
 analytics worker (Python)
   │  publishes one Sighting per tracked vehicle, with its plate reads
   ▼
 Valkey stream `sightings`
   │
   ▼
 consumers/sightings.ts        insert commits ──┐
   │                                            │  correlation runs AFTER the commit and
   │                                            │  BEFORE the ack, so a crash replays the
   ▼                                            │  batch and dedupe makes the replay harmless
 AlertEngine.correlateBatch ◄────────────────────┘
   │
   ├─ evaluatePlateRead()      D2-03 grammar: normalise, correct, down-weight
   │     └─ structurally non-plate?  → maxDistance 0 (exact only, no fuzzy expansion)
   │     └─ below the confidence floor? → refused before any lookup
   │
   ├─ registry.lookupVehicle(plate, { at: sightingTs, maxDistance })
   │     └─ `at` is the SIGHTING's instant, never `now`  ← §6
   │
   ├─ severityFor()            category → ceilings → final
   ├─ reasonFor()              the why-payload, including a presigned crop URL
   ├─ upsert()                 sliding-window dedupe, unique index as the backstop
   ├─ DeliveryGate.admit()     cap the operator's queue, digest the overflow
   └─ bus.publish() + pg_notify → GET /api/v1/alerts/stream (SSE)
```

**Correlation lives in the API, not in the Python worker.** The worker reads pixels; the watchlist,
the validity windows, the dedupe state and the audit chain are all on this side of the bus, and
correlating in the worker would mean shipping all four across it. It is also the only place where a
read already has the `sighting_id` Postgres generated.

---

## 3 · Dedupe

**Key:** `${watchlistEntryId}:${cameraId}` · **Window:** 10 minutes (`config/alert-policy.json` →
`dedupe.windowMinutes`) · **Scope:** camera.

A re-sighting inside the window does not create a row. It increments `sighting_count`, moves
`last_seen_at`, and records `last_sighting_id` / `last_observed_plate`. `alerts.ts` stays the **first**
sighting, so one row says *"first seen 09:00, still here 09:04:45, 20 times"*.

### Why camera-scoped

The same vehicle at a **different** camera is not a repeat — it is movement, and movement is the
thing a control room is watching for. Deduping across cameras would collapse a vehicle's route into
one row and delete the signal. `alerts-dedupe.test.ts` AC 3 asserts two dedupe keys for one plate
across two cameras.

### Sliding, not tumbling — and why the unique index is not enough on its own

`alerts_dedupe_uidx` is `UNIQUE (dedupe_key, dedupe_window_start)`. If `dedupe_window_start` were the
whole mechanism, windows would **tumble**: twenty sightings spanning 09:59 → 10:04 straddle a bucket
boundary and produce **two** alerts, which is the acceptance criterion failing.

So the engine probes a **sliding** window first — *"is there an alert on this key whose last sighting
is within ±10 minutes?"* — and updates it if so. The unique index stays as the **concurrency
backstop**: two consumers correlating the same read at the same instant collide on the index and the
loser's `ON CONFLICT DO UPDATE` bumps the count instead of inserting. `alerts-dedupe.test.ts` covers
both — the boundary-straddle case and the constraint itself (`23505`, `alerts_dedupe_uidx`).

### A dismissed alert still accumulates

Dedupe does not check status. That a vehicle an operator dismissed came back twelve more times is
exactly what a supervisor needs to see, and raising a second alert somebody has already judged is
the fatigue this whole ticket exists to prevent. The count moves; the queue does not.

### Measured, on this estate

`saakshi_d2_06` holds **28,438 real sightings** across **7 cameras** and **928 track sessions** from
D2-01's live run. Against the real timestamps and the real camera/track structure:

```sql
with sessions as (
  select camera_id, track_id, min(ts) as first_ts, count(*) as n
    from sightings group by 1, 2)
select count(*) as track_sessions, sum(n) as sightings,
       count(distinct (camera_id,
             to_timestamp(floor(extract(epoch from first_ts) / 600) * 600))) as alerts_if_all_hit
  from sessions;
```

| | |
|---|---|
| track sessions | **928** |
| sightings | **28,438** |
| alerts if *every* session hit the watchlist | **7** |
| reduction vs sightings | **99.98%** |
| reduction vs track sessions | **99.25%** |

**Read that honestly.** It is an upper bound on the collapse, not a claim about the estate's real
alert volume, and it is flattered by one thing: D2-01's run is ~5 minutes of feed, so every sighting
on a camera falls inside **one** 10-minute window. On a 24-hour estate the same query returns roughly
`cameras × 144` buckets rather than 7. The number that survives that caveat is the *shape*: dedupe is
what protects the operator, and the rate limiter (§5) is only the last line of defence behind it.

The storm benchmark measures the same thing without the caveat — 500 sightings of one vehicle at one
camera over 5 minutes collapse to **1 alert**, a **99.80%** reduction, at 284 reads/s on one
connection.

---

## 4 · Severity, and the reason it is capped

### The rule

**Severity starts from the watchlist category and identification quality can only lower it.**

The *record's* seriousness is a question a department answers in a JSON file. Only then does the read
get a say, and its only power is to cap. A system where a detector's confidence could **raise**
severity is a system where a confident misread outranks a human's judgement about a case.

### The category map

`config/alert-policy.json` → `severity.byCategory`:

| category | severity | rank |
|---|---|---|
| `wanted_person` | `critical` | 1 |
| `stolen_vehicle` | `high` | 2 |
| `blacklisted_vehicle` | `high` | 3 |
| `suspect` | `medium` | 4 |
| `missing_person` | `low` | 5 |

The ticket specifies a strict five-way ordering and `alert_severity` has four values, so two
categories necessarily share `high`. `categoryRank` carries the ordering the queue sorts on — without
it, collapsing five onto four would silently lose it. `GET /api/v1/alerts?sort=severity` orders by
rank first, severity second.

`missing_person` is `low` **as an alert severity**, which is not a statement about how much a missing
person matters. It is a statement about what an ANPR hit on one is: a lead to follow carefully, not a
reason to intercept a vehicle. The rank keeps it visible in its own right.

`entrySeverity: "ceiling"` (the default) lets the severity a human put on the entry **cap** the
category default without being able to raise it. The five `estate-ocr-output` entries D2-05 seeded
are marked `low` precisely because they are OCR fragments rather than registrations, and a category
default must not shout over that. `"override"` and `"ignore"` are the other two modes.

### Why identification quality caps it — the measurement, not an opinion

- D2-01 measured **0 exact plate reads** across a 120-instance hand-labelled sample of this estate,
  because only **3** plates were legible at all.
- D2-03 correctly rejected **all 15** strings the live run produced — `0 valid, 0 partial, 15
  rejected`.
- The single **highest-confidence read of the entire run** was `757508300` at **0.888**: the phone
  number on a roadside advertising hoarding on cam05.

**An engine that fires `critical` on input like that is manufacturing certainty from noise.** The
ceilings are the arithmetic that stops it:

| id | fires when | caps at | why |
|---|---|---|---|
| `fuzzy-never-critical` | `matchType = fuzzy` | `high` | A fuzzy match is a ranked possibility. Something that might be a different vehicle does not get to be the most serious thing on the screen. |
| `partial-plate` | `validity = partial` | `high` | A clean prefix is a usable identification and the dominant outcome here — but it names a *set* of vehicles, not one. |
| `ungrammatical-read` | `validity = invalid` | `low` | Not a registration under any layout. `757508300` is what the top of this distribution looks like. |
| `combined-below-80` | combined < 0.80 | `high` | |
| `combined-below-55` | combined < 0.55 | `medium` | |
| `combined-below-30` | combined < 0.30 | `low` | |

Every ceiling that fires is named in `reason.severityBasis.ceilingsApplied` and restated in
`reason.caveats` — the officer sees *"Severity was lowered from high to medium by: combined-below-55"*
rather than an unexplained number.

### Combined confidence is a product

```
combinedConfidence = adjustedPlateConfidence × matchConfidence
```

A **product**, not a mean or a maximum, because the two are independent failure modes and both have
to hold: reading the plate right, and matching it to the right record. A mean lets a confident read
of the wrong string look like a good alert.

`adjustedPlateConfidence` is D2-03's grammar-adjusted OCR confidence, not the raw model output.
`matchConfidence` is D2-04's match strength — `1` for exact. `reason.identification` carries all
three separately so the arithmetic can be checked rather than trusted.

### The word beside the number

`reason.identification.strength` is `confirmed` | `probable` | `possible` | `weak`. `confirmed`
requires an **exact** match on a **grammar-valid** registration at combined ≥ 0.80 — which, on this
estate, has never once happened. A label a fragment can earn is a label that means nothing.

---

## 5 · Rate limiting: cap delivery, never persistence

`rateLimit.deliveriesPerMinute: 120` — two per second. Fast enough that a real incident is never held
back, slow enough that a stuck feed re-detecting the same scene cannot fill a screen.

**Nothing is dropped.** Every alert row is written to `alerts` whatever the cap says. What is capped
is the **operator's queue**, because the thing that actually drowns in a camera storm is the human,
not Postgres. Suppressed alerts are aggregated into one `alert_digests` row per window with counts by
severity, category and camera plus a sample of ids, and a `digest` event goes out on the stream, so
the operator is told what they were not shown.

Fixed windows rather than a token bucket, deliberately: the cap has to be **reportable** — *"in the
14:02 minute you were shown 120 and not shown 380"* is a sentence a digest can make and a
continuously-refilling bucket cannot. The cost is the usual fixed-window edge case (up to 2× the cap
across a boundary), which for a human queue is not a failure.

### Measured — `npm run bench:alert-storm`

```
ALERT STORM — 500 alerts into one minute, cap 120/min
PHASE 1 — the delivery cap
  injected           500
  delivered live     120   (cap 120)
  suppressed         380
  digested           380  in 1 digest row(s)
  accounted for      500 / 500
      by severity  {"critical":95,"high":95,"medium":95,"low":95}
      by category  {"wanted_person":95,"stolen_vehicle":95,"blacklisted_vehicle":95,"suspect":95}
  cap held           YES
  nothing dropped    YES
PHASE 2 — dedupe, which is what the operator actually feels
  sightings injected 500 (one vehicle, one camera, 5 minutes)
  alert rows         1
  reduction          99.80%  (500 → 1)
  throughput         284 reads/s (3.52 ms per read, one connection)
```

The benchmark drives the gate with a **frozen clock**. A run that injects 500 alerts in three real
seconds and calls that window "a minute" is measuring the machine, not the cap.

---

## 6 · Two traps this engine is built around

**`at:` is the sighting's timestamp, never `now`.** Validity windows are evaluated at `at`,
`valid_from` inclusive and `valid_to` **exclusive**. Replaying yesterday's sightings against `now`
silently drops every entry whose window has since closed — and *"would this have matched at the time
of the sighting?"* is the only fair question to ask of the person on the list. `alerts.test.ts` AC 9
asserts the inside, the outside and the exclusive boundary.

**Never correlate on `raw_text`.** `plate_reads.raw_text` is a string a camera produced, not a
registration. Every read goes through D2-03's `evaluatePlateRead` first, and a read D2-03 classifies
as structurally non-plate (`no_letters`, `no_digits`, `empty`, `too_short`) is given `maxDistance: 0`
— fuzzy matching disabled. Fuzzy-expanding a phone number invents neighbours that were never on any
vehicle. The **exact** path stays open for those strings, because exact string equality against a
watchlist entry is a fact rather than an inference; the `ungrammatical-read` ceiling is what keeps
that fact at `low`.

---

## 7 · What this engine actually does to this estate

Every one of the 15 strings D2-01's live run emitted, plus the two ground-truth registrations that
genuinely appear on cam07, put through the engine against the 235-entry watchlist:

| read | raw conf | validity | alert? | match | distance | combined | severity | ceilings |
|---|---|---|---|---|---|---|---|---|
| `757508300` | 0.888 | invalid | **no** (`no_watchlist_hit`) | - | - | - | - | - |
| `44671` | 0.732 | invalid | **yes** | exact | 0.00 | 0.0730 | low | `entry-severity` |
| `P41` | 0.687 | invalid | **no** | - | - | - | - | - |
| `1118R` | 0.627 | invalid | **yes** | exact | 0.00 | 0.2510 | low | `entry-severity` |
| `41111` | 0.584 | invalid | **no** | - | - | - | - | - |
| `755508000` | 0.575 | invalid | **no** | - | - | - | - | - |
| `46101` | 0.560 | invalid | **yes** | exact | 0.00 | 0.0560 | low | `entry-severity` |
| `46111` | 0.514 | invalid | **no** | - | - | - | - | - |
| `AAM412` | 0.503 | invalid | **yes** | exact | 0.00 | 0.2010 | low | `entry-severity` |
| `GJ3266416` | 0.449 | invalid | **yes** | exact | 0.00 | 0.1800 | low | `entry-severity` |
| `15144` | 0.429 | invalid | **no** | - | - | - | - | - |
| `41111` | 0.360 | invalid | **no** | - | - | - | - | - |
| `71TT` | 0.355 | invalid | **no** | - | - | - | - | - |
| `7` | 0.336 | invalid | **no** | - | - | - | - | - |
| `A1110` | 0.323 | invalid | **no** | - | - | - | - | - |
| `GJ35U07` | 0.600 | partial | **yes** | fuzzy | **0.70** | 0.3450 | **medium** | `combined-below-55` |
| `GJ32DD10` | 0.600 | partial | **yes** | fuzzy | **0.55** | 0.3680 | **medium** | `combined-below-55` |

**7 alerts from 17 reads: 5 `low`, 2 `medium`, 0 `high`, 0 `critical`.**

That distribution is the point of this document. The estate's ANPR reads almost nothing, and the
alert queue says so. The two `medium` alerts are the two real registrations, recovered by D2-04's
confusion-aware metric from truncated reads and presented as *possibilities* with their distance
attached. The five `low` alerts are exact string matches against entries that are themselves labelled
*"SELECTED FROM MEASURED ANPR OUTPUT, NOT FROM A VEHICLE REGISTRY"*, and that note travels with the
alert in `reason.watchlistRecord.note`.

And `757508300` — the highest-confidence read of the whole run — produces **nothing**.

> **No accuracy claim is made here.** These are deterministic outputs of a policy file and a matcher
> over a recorded set of strings. Reproduce them with the test suite and `npm run bench:alert-storm`.

**Caveat on the crops.** The `saakshi_d2_06` database used for these measurements holds 28,438 real
sightings with `crop_uri IS NULL` on every one — D2-02's evidence consumer was never run against it,
so the estate's own crops are not there. The signed-crop path is proven end to end against a real
MinIO with a real object in `alerts.test.ts` ("carries a crop the operator can actually open"), which
GETs the presigned URL and asserts 200. Logged to `BL-01`.

---

## 8 · The why-payload

Non-negotiable and asserted field by field. `REQUIRED_WHY_FIELDS` in `@saakshi/shared` is the list;
`alerts.test.ts` AC 5 walks every path and fails on any null.

```jsonc
{
  "matchType": "fuzzy",
  "matchDistance": 0.7,                    // continuous — never round without saying so
  "explanation": "…",                      // the matcher's own words
  "identification": {
    "observedPlate": "GJ35U07",            // canonical form of what the camera produced
    "correctedPlate": "GJ35U07",           // after D2-03's slot-aware correction
    "watchlistValue": "GJ35U0779",
    "validity": "partial", "grammarValid": false, "grammarCorrected": false,
    "rejectionCodes": ["truncated"], "missingChars": 2, "completeness": 0.777,
    "plateConfidence": 0.6,                // raw OCR
    "adjustedPlateConfidence": 0.45,       // after D2-03 grammar down-weighting
    "matchConfidence": 0.767,              // D2-04 match strength — NOT OCR confidence
    "combinedConfidence": 0.345,           // the product of the two
    "strength": "possible"
  },
  "severityBasis": {
    "fromCategory": "high", "fromEntry": "high",
    "ceilingsApplied": ["combined-below-55"], "final": "medium", "categoryRank": 2
  },
  "camera":   { "id": "…", "externalId": "cam07", "name": "07 hero-showroom-gir-somnath",
                "location": null, "district": null, "trustScore": null },
  "sighting": { "id": "…", "ts": "…", "framePtsMs": 4001, "trackId": 900001, "vehicleClass": "car" },
  "evidence": { "cropUri": "s3://saakshi-evidence/evidence/…jpg",
                "cropUrl": "https://…X-Amz-Signature=…", "cropUrlExpiresInS": 900,
                "isBestShot": true },
  "watchlistRecord": {
    "entryId": "…", "category": "stolen_vehicle", "entityType": "vehicle",
    "sourceSystem": "eGujCop", "providerSystem": "eGujCop", "live": false,
    "entrySeverity": "high", "validFrom": "…", "validTo": null,
    "note": "ESTATE GROUND TRUTH — …"      // the seed row's provenance, verbatim
  },
  "caveats": ["Matched against SAAKSHI's representative watchlist (eGujCop connector, mock). …",
              "FUZZY MATCH — the read 'GJ35U07' is not identical to the watchlist plate …",
              "The read is a PARTIAL registration — 2 character(s) short …",
              "Severity was lowered from high to medium by: combined-below-55.", "…"],
  "disclaimer": "MOCK PROVIDERS — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS …",
  "policyVersion": 1
}
```

**Three fields may legitimately be `null`**, and each must produce a matching `caveats` entry —
`EXPLAINED_NULL_FIELDS` names them and the AC-5 test enforces the pairing:

| field | when | caveat phrase |
|---|---|---|
| `camera.location` | the registry has no geometry for this camera | *no location on file* |
| `camera.trustScore` | the camera has never been probed (never scored 0 for being unmeasured) | *never probed* |
| `evidence.cropUrl` | no crop stored, or no object store configured | *no crop URL* |

**`cropUri` is `s3://bucket/key`, never a URL.** A signed URL persisted in the database is a
credential with an expiry rotting in a column — it would be dead within the hour. The URL is minted
at read time by `EvidenceStore.presignGet`, which is synchronous and makes no network call, so one
per alert costs nothing. It is signed for **GET**: a `HEAD` of it answers 403 against a store that is
working perfectly, because the HTTP method is part of the SigV4 canonical request.

**`caveats` is never empty.** Even a perfect exact match carries the mock-provider line, because the
one claim that must never be implied is that VAHAN answered.

---

## 9 · Lifecycle

```
        ┌──────────────► dismissed  (terminal)
        │                    ▲
  new ──┼──► ack ────────────┤
        │     ▲              │
        └──► escalated ──────┘
              (ack ⇄ escalated)
```

`dismissed` is terminal on purpose: an operator who dismissed an alert made a judgement, and quietly
reopening it would hide that the judgement was overridden. Re-raising means a new sighting and a new
alert, which is a fact rather than an edit.

`transitionAlert()` takes a `SELECT … FOR UPDATE` inside the transaction — two officers clicking ack
and dismiss at the same instant is a real control-room event — and writes the `audit_log` row in that
same transaction. An illegal transition is `409 illegal_transition`.

`acked_by`/`acked_at` and `status_changed_by`/`status_changed_at` are kept separate: an escalation
after an ack must not erase the name of the officer who acknowledged it.

**Roles.** `operator` **can** transition, unlike the registry's write matrix — acknowledging alerts is
the control-room seat's entire job, and a queue only a supervisor can clear is a queue that fills up.
`auditor` cannot, for the reason `auth.ts` gives: an auditor who can change the thing being audited is
not an auditor.

---

## 10 · The API

| method | path | roles | notes |
|---|---|---|---|
| `GET` | `/api/v1/alerts/stream` | read | SSE. Events `ready` · `alert` · `digest` · `ping` (15 s) |
| `GET` | `/api/v1/alerts` | read | filter by status/severity/category/matchType/camera/since; `sort=recent\|severity`; keyset on `lastSeenAt` |
| `GET` | `/api/v1/alerts/:id` | read | one alert with its full why-payload |
| `GET` | `/api/v1/alerts/digests` | read | rate-limit overflow summaries |
| `GET` | `/api/v1/alerts/stats` | read | queue composition, measured dedupe ratio, live cap counters |
| `POST` | `/api/v1/alerts/:id/transition` | admin · supervisor · operator | `{ to, note? }` → 200 / 409 |

**SSE, not WebSocket.** The traffic is one-way. SSE reconnects on its own, survives a proxy that only
speaks HTTP, and needs no client library. Lifecycle actions go over ordinary POSTs where they can be
authorised and audited like every other mutation.

**The stream accepts `?access_token=`** as well as the `Authorization` header, because the browser's
`EventSource` cannot set headers — a limitation of the API, not something D2-07 can code around. The
parameter is stripped from the request URL before it reaches the logger.

```bash
TOKEN=$(...)                                   # a JWT for a seeded user
curl -N -H "Authorization: Bearer $TOKEN" localhost:4000/api/v1/alerts/stream
curl -N "localhost:4000/api/v1/alerts/stream?access_token=$TOKEN"
```

**Cross-process fan-out.** The consumer that raises alerts is its own process (`npm run
consume:sightings`) and the API may be several replicas, so a bus that only reached one process would
leave every operator's stream empty in exactly the deployment the sizing calls for. The engine issues
`pg_notify('saakshi_alerts', '{type,id,deduped}')`; the API `LISTEN`s on a dedicated connection and
loads the row. Ids only — `NOTIFY`'s payload is capped at 8000 bytes and a why-payload is larger. The
bus drops an event whose `(type, id, sightingCount)` it published in the last 10 s, so a
single-process deployment does not deliver everything twice.

---

## 11 · Audit

| action | written | why here |
|---|---|---|
| `watchlist.lookup.auto` | one per correlation **batch** | D2-05's handoff: an in-process registry call bypasses the HTTP route's audit write. Per-lookup would be one serialised hash-chain write per plate read — a chain longer than the data it describes, and a hard serialisation point in the ingest path. |
| `alert.raise` | one per alert **created** (not per dedupe bump) | The decision, not the query, is what a review asks about. |
| `alert.ack` / `.dismissed` / `.escalated` | one per transition, in the same transaction | An audit row without its mutation is noise; a mutation without its audit row is what the table exists to prevent. |

---

## 12 · Claims discipline

- **No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity.** `reason.watchlistRecord.live` is
  the literal `false` on every alert, `reason.disclaimer` says so in words, and `caveats[0]` repeats
  it. All three are on the response **body**, because the body is what ends up in a screenshot.
- **No face recognition, no biometrics.** AFIS and NAFIS are reference-only. The alert engine reads
  `watchlist_entries.meta`, which the contract boundary already refuses 21 biometric key names from.
- **No accuracy claim.** §7 is the deterministic output of a policy file over a recorded set of
  strings, including every read that produced nothing.
- **A fuzzy match is never presented as certainty.** `matchType`, the continuous `matchDistance`, the
  three separate confidences and an explicit *"ranked possibility, not an identification"* caveat all
  travel on the payload. D2-07 renders them; it does not get to decide whether to.

---

## 13 · Configuration reference

`config/alert-policy.json`, read from disk at runtime — a change alters the running system with no
rebuild, which `alerts.test.ts` AC 4 proves by scoring one identical hit under two policy files.

| key | default | effect |
|---|---|---|
| `dedupe.windowMinutes` | `10` | how long a re-sighting folds into the existing alert |
| `severity.byCategory` | see §4 | the starting severity per category |
| `severity.categoryRank` | see §4 | strict queue ordering, since 5 categories map onto 4 levels |
| `severity.entrySeverity` | `ceiling` | `ceiling` \| `ignore` \| `override` — how the entry's own severity applies |
| `severity.identificationCeilings` | 6 rules | caps by match type, validity and combined confidence |
| `correlation.maxDistance` | `2` | D2-04's measured operating point |
| `correlation.fuzzyRefusalCodes` | 4 codes | D2-03 verdicts that disable fuzzy expansion for a read |
| `correlation.minPlateConfidence` | `0.25` | raw OCR floor, below which no lookup runs |
| `rateLimit.deliveriesPerMinute` | `120` | the operator queue's cap |
| `rateLimit.digestSampleSize` | `5` | suppressed alert ids kept per digest |
| `evidence.cropUrlExpiresInS` | `900` | signed crop URL lifetime |
