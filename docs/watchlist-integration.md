# Watchlist integration — the connector specification

> **SAAKSHI has no live VAHAN, SARTHI, eGujCop (CCTNS), AFIS or NAFIS connectivity, and this
> document does not claim any.** Every provider that ships is a mock. What follows is the
> *specification* each connector would implement, the access Gujarat Police would have to grant, and
> the evidence that the swap from mock to live is a connector change rather than a rebuild.
>
> The challenge's problem statement says participants *"may create and use their own representative
> watchlist database."* That is what `fixtures/watchlist-seed.csv` is. Nothing in it is a real
> vehicle, a real person or a real case, with one carefully-marked exception described in §7.

**SAAKSHI processes no biometric data and performs no face recognition.** AFIS and NAFIS appear here
as *reference* systems only: an entry may carry the identifier under which a subject is held in
those systems, and nothing else. This is enforced in code, not asserted — see §6.

---

## 1 · The shape every connector implements

```ts
interface WatchlistProvider {
  readonly system: 'VAHAN' | 'SARTHI' | 'eGujCop' | 'AFIS' | 'NAFIS' | 'manual';
  lookupVehicle(plateNormalized: string, options?: LookupOptions): Promise<WatchlistHit[]>;
  lookupPerson(ref: string, options?: LookupOptions): Promise<WatchlistHit[]>;
  sync(since?: Date): Promise<SyncResult>;      // bulk pull into watchlist_entries
  health(): Promise<ProviderHealth>;
}
```

`packages/api/src/watchlist/provider.ts`. A connector is registered with
`WatchlistRegistry.register(provider)` and **nothing else in the system changes** — not the routes,
not the mock provider, not the matcher. The test
`a second provider registers with zero core changes` proves it structurally: it defines a whole
provider inside the test file, imports only the exported interface, and registers it. If any part of
the core had to know about that provider, the test could not compile.

Providers are keyed by `system`, so registering a real eGujCop connector **replaces the eGujCop mock
and leaves the other five answering**. That is the cutover a department would actually ask for: one
system at a time, with the rest still serving.

### `WatchlistHit` — what a lookup returns

D2-06's alert engine consumes this directly.

| field | type | notes |
|---|---|---|
| `entryId` | uuid | `watchlist_entries.id` |
| `category` | `stolen_vehicle` · `wanted_person` · `missing_person` · `blacklisted_vehicle` · `suspect` | |
| `entityType` | `vehicle` · `person` | |
| `plateNormalized` | `string \| null` | uppercase `A-Z0-9`, no separators |
| `personRef` | `string \| null` | opaque case reference, **never biometric** |
| `sourceSystem` | the six above | the system this record is *modelled on* |
| `sourceRef` | `string \| null` | the upstream's own identifier |
| `providerSystem` | the six above | which provider answered |
| **`live`** | `false` | **always**, for every provider in this repository |
| `severity` | `low` · `medium` · `high` · `critical` | |
| `matchType` | `exact` · `fuzzy` | |
| `matchDistance` | int ≥ 0 | `0` for exact |
| `matchConfidence` | 0–1 | `1` for exact. **Match strength, not OCR confidence** |
| `matchExplanation` | string | the why, for the alert's three-second verification |
| `validFrom` / `validTo` | ISO 8601 | `validTo` is **exclusive** |
| `meta` | object | per-system detail, §5 |

`ProviderHealth.live` is typed as the literal `false`. A provider cannot claim to be live without a
type change and a code review — which is the point.

---

## 2 · What Gujarat Police would have to provide

This is the operative section. Everything below is a request, not a description of something we
have.

| # | What we need | Why | Without it |
|---|---|---|---|
| 1 | **A named integration owner per system** (NIC for VAHAN/SARTHI, SCRB for CCTNS, NCRB for NAFIS) | Every one of these is a different custodian with a different approval path | No connector can be commissioned |
| 2 | **Written purpose authorisation** naming the lawful basis for automated lookup | DPDP Act 2023 §7(g)/(h) and the Motor Vehicles Act enforcement provisions | We will not build a lookup we cannot justify in an audit |
| 3 | **A service account per system**, not a shared one | `audit_log.actor_id` must attribute every lookup to a person and a system | Attribution collapses; the audit chain becomes unusable |
| 4 | **Network path**: NICNET / SWAN reachability, or a documented egress allowlist | These systems are not on the public internet | Connectors cannot reach anything |
| 5 | **mTLS client certificates** (or the department's standard) with a rotation procedure | Every one of these APIs authenticates the *institution*, not a bearer token | No authentication is possible |
| 6 | **The actual API contract** — OpenAPI, WSDL or a field dictionary | The public documentation for all five is either absent or describes a citizen-facing subset | We are guessing at field names; §5's mapping is our best inference |
| 7 | **A rate-limit and quota statement**, in writing | Sizing depends on it: 30 cameras at this estate's plate yield is ~1 lookup/min, but a 500-camera estate is not | We must assume the most conservative number and cache aggressively |
| 8 | **A bulk/delta export** of stolen and blacklisted vehicles for the districts in scope | Per-sighting lookup against a national system is the wrong shape for real-time alerting (§4) | Every alert waits on a network round trip we do not control |
| 9 | **A test/UAT environment** with synthetic records | We will not test against live citizen data | Integration cannot be validated before it is live |
| 10 | **A retention and deletion instruction** per system | We must not hold a record longer than the custodian permits | We default to the shortest window we can defend |

**Explicitly not requested: any biometric data, any facial image, any fingerprint or iris template,
from any system.** See §6.

---

## 3 · Per-system specification

### 3.1 · VAHAN — vehicle registration (MoRTH / NIC)

| | |
|---|---|
| **Custodian** | National Informatics Centre, for the Ministry of Road Transport & Highways |
| **What we need from it** | Registration status, make/model/colour, RC status, and the theft/blacklist flag for a registration number |
| **Endpoints needed** | (a) single-registration lookup by registration number; (b) a delta export of theft- and blacklist-flagged registrations for a district set, since a timestamp |
| **Auth model** | mTLS client certificate issued to the department + service-account credential; NICNET-side IP allowlist. No bearer tokens |
| **Request shape we assume** | `GET /vehicle/{registrationNumber}` returning one record; `GET /vehicle/flagged?district=&since=` returning a page |
| **Sync cadence** | Delta pull **hourly**; on-demand single lookup only for an alert an operator is actively verifying |
| **Rate limits** | Unknown — item 7 above. We design for **≤ 1 request/second sustained** and cache a negative result for 15 minutes, a positive one for 60 |
| **Failure mode** | Circuit breaker after 5 consecutive failures, 30 s open; alerts continue from the last delta pull. **A connector outage must degrade the freshness of the watchlist, never stop alerting** |
| **Fields consumed** | `registration_no` → `plate_normalized` · `maker` → `meta.make` · `model` → `meta.model` · `colour` → `meta.colour` · `rc_status` → `meta.rc_status` · owner **reference** → `meta.owner_ref` |
| **Fields deliberately NOT consumed** | Owner name, address, mobile, Aadhaar/PAN reference, chassis and engine numbers. None of them is needed to raise an alert on a plate, and holding them widens the breach surface for no operational gain |

### 3.2 · SARTHI — driving licence (MoRTH / NIC)

| | |
|---|---|
| **Custodian** | NIC, same channel as VAHAN |
| **What we need from it** | Whether a licence is suspended, disqualified or expired, by DL number |
| **Endpoints needed** | `GET /licence/{dlNumber}` — validity and status only |
| **Auth model** | As VAHAN |
| **Sync cadence** | **On-demand only.** There is no bulk case: SAAKSHI reads plates, not drivers, so a licence is looked up when an officer has a DL number in hand |
| **Rate limits** | Assume the same conservative envelope as VAHAN |
| **Fields consumed** | `dl_no` → `meta.dl_no` · holder **reference** → `meta.holder_ref` · `valid_upto` → `meta.dl_valid_to` · status → `meta.wanted_status` |
| **Fields deliberately NOT consumed** | Holder name, photograph, address, date of birth, blood group. The photograph in particular is refused at the schema level (§6) |

### 3.3 · eGujCop / CCTNS — case records (Gujarat SCRB)

The system that matters most, because it is where a *reason to alert* actually lives.

| | |
|---|---|
| **Custodian** | State Crime Records Bureau, Gujarat |
| **What we need from it** | Stolen-vehicle records, wanted-person and missing-person records, each with its FIR reference and the station that raised it |
| **Endpoints needed** | (a) `GET /stolen-vehicles?district=&since=` — delta export; (b) `GET /persons/wanted?since=`, `GET /persons/missing?since=`; (c) `GET /fir/{firRef}` for the verification pane |
| **Auth model** | Department service account over SWAN, mTLS; per-station scoping so a district's operators see their own district's records |
| **Sync cadence** | **Delta pull every 15 minutes.** A vehicle reported stolen this morning must be on the watchlist this afternoon; a nightly pull is the difference between recovering a vehicle and reading about it |
| **Rate limits** | Delta-first design means steady-state load is 96 requests/day per category, not one per sighting |
| **Fields consumed** | `fir_no` → `meta.fir_ref` · `police_station` → `meta.police_station` · `status` → `meta.wanted_status` · vehicle registration → `plate_normalized` · case reference → `person_ref` |
| **Fields deliberately NOT consumed** | Complainant details, accused personal details, statements, case narrative. SAAKSHI needs *that a case exists* and *what to look for* — not the case file |
| **Write-back** | **None. SAAKSHI never writes to CCTNS.** An alert is a lead for an officer, not a case update |

### 3.4 · AFIS and NAFIS — reference only

| | |
|---|---|
| **Custodian** | State AFIS (Gujarat) · NAFIS (NCRB) |
| **What we consume** | A **subject reference string** and nothing else — `meta.subject_ref`, e.g. `NAFIS-SUBJECT-00042` |
| **What we never consume** | Fingerprint minutiae, templates, iris codes, palm prints, facial images, DNA profiles, or any match score derived from them |
| **Endpoints needed** | None for matching. At most a *validity* check that a reference still exists |
| **Auth model** | Moot — the integration is a reference, not a query against biometric data |
| **Sync cadence** | With the CCTNS delta that carries the reference |
| **Why it is in the interface at all** | Because the problem statement names these systems, and the honest answer is not to omit them but to say precisely what a lawful integration would and would not include. A reference lets an officer take a lead to the system that *is* authorised to run a biometric comparison. SAAKSHI is not that system |

**No face recognition is performed anywhere in SAAKSHI.** The analytics pipeline detects `person` as
a bounding box for counting and loitering; nothing is derived from a face. This is a deliberate
scope decision, documented in `CLAUDE.md` and `PROJECT.md`: it is not mandated by the challenge, and
it requires separate legal authorisation that no hackathon submission can claim to hold.

### 3.5 · `manual` — the desk

Not an external system: entries an authorised officer creates directly, through
`POST /api/v1/watchlist` or a CSV import. This is the path that works on day one with no external
approval at all, and it is the one the demo uses.

---

## 4 · Why bulk delta, not per-sighting lookup

A live run on this estate produced **15 plate reads from 640 tracks in five minutes**
(`docs/anpr-accuracy.md` §8). Scaled to a 500-camera estate that is still only a few reads per
second — but each would become a synchronous call into a national system on the critical path of an
alert.

Three reasons the watchlist is a **local table fed by delta pulls**, and the lookup is local:

1. **Latency.** An alert that waits on NICNET is an alert an operator does not see while the vehicle
   is still in frame.
2. **Availability.** A connector outage degrades freshness. A per-sighting design would make it an
   alerting outage.
3. **Privacy.** A per-sighting lookup sends *every plate the estate sees* to a national registry —
   including the thousands belonging to people of no interest. A delta pull sends nothing and asks
   about nobody. This is data minimisation as an architecture, not as a policy statement.

The per-registration lookup in §3.1 exists for the *verification* step, when an operator is already
acting on an alert — one call, with a stated purpose, audited.

---

## 5 · Field mapping

The CSV column list **is** the mapping. `fixtures/watchlist-seed.csv` has one column per real-system
field, which is what makes this document checkable rather than aspirational — and what lets a
department edit an export in Excel and hand it back.

| CSV column | `watchlist_entries` | Source system field |
|---|---|---|
| `source_system` | `source_system` | which connector this is modelled on |
| `source_ref` | `source_ref` | VAHAN record id · SARTHI DL no. · CCTNS FIR ref · AFIS/NAFIS subject ref |
| `category` | `category` | derived from the upstream record type |
| `entity_type` | `entity_type` | `vehicle` or `person` |
| `plate` | `plate_normalized` | VAHAN `registration_no` / CCTNS stolen-vehicle registration |
| `person_ref` | `person_ref` | CCTNS case reference |
| `severity` | `severity` | policy mapping, §5.1 |
| `valid_from` / `valid_to` | `valid_from` / `valid_to` | upstream record validity |
| `active` | `active` | upstream record still open |
| `make` `model` `colour` `owner_ref` `rc_status` | `meta.*` | **VAHAN** |
| `dl_no` `holder_ref` `dl_valid_to` | `meta.*` | **SARTHI** |
| `fir_ref` `police_station` `wanted_status` | `meta.*` | **eGujCop / CCTNS** |
| `subject_ref` | `meta.subject_ref` | **AFIS / NAFIS — reference only** |
| `note` `provenance` | `meta.*` | ours: what this row is and where it came from |

### 5.1 · Severity is a policy decision, not a field

No upstream system emits "critical". The mapping from record type to `alert_severity` is ours and
belongs to the department:

| upstream | default severity |
|---|---|
| stolen vehicle, FIR open | `high` |
| wanted person, non-bailable warrant | `high` (`critical` where the record says so) |
| missing person | `medium` |
| blacklisted vehicle (RC suspended, permit lapsed) | `medium` |
| suspect / under investigation | `low` |

It is a column in the CSV precisely so a supervisor can change it without a code change.

---

## 6 · No biometrics — enforced, not asserted

`BIOMETRIC_FIELD_DENYLIST` in `packages/api/src/watchlist/provider.ts` refuses 21 key names —
`face_embedding`, `fingerprint`, `minutiae`, `iris`, `photo`, `dna`, `voiceprint`, `palmprint` and
their variants — **case- and separator-insensitively, at any depth**, on three paths:

- `POST /api/v1/watchlist` → `400`
- `POST /api/v1/watchlist/import` → per-row rejection naming the offending column
- the mock provider's `sync()` → the row is rejected, not silently stripped

Tested by `no biometric data, anywhere` (5 assertions) and
`refuses a biometric field with a 400 — SAAKSHI processes no biometrics`.

The reason it is enforced rather than documented: an unenforced "we don't store biometrics" survives
exactly until the first person pastes a face embedding into a free-form JSON column, and then the
claim is false and nobody knows.

---

## 7 · The representative dataset, and its provenance

`fixtures/watchlist-seed.csv` — **235 entries** across all five categories, regenerated
deterministically by `scripts/gen-watchlist-seed.py` and loaded by `npm run seed:watchlist`
(idempotent: it upserts on `(source_system, source_ref)`).

| category | entries |
|---|---|
| `stolen_vehicle` | 76 |
| `blacklisted_vehicle` | 51 |
| `wanted_person` | 40 |
| `suspect` | 38 |
| `missing_person` | 30 |

Every row carries a `provenance` field. There are three values, and the distinction between them is
the whole of this section's honesty.

### `synthetic` — 224 rows

Generated. No row describes a real vehicle, a real person or a real case. Owners and subjects are
**references** (`VAHAN-OWNER-0042`, `NAFIS-SUBJECT-00117`), never names: a representative dataset
does not need invented people, and inventing them is how a demo becomes a fabricated record.

Ten percent carry a **closed validity window** on purpose, so "an expired entry must not alert" is
demonstrable against the shipped data and not only inside a unit test.

### `estate-groundtruth` — 4 rows

Registrations a **human** read off the sandbox feeds. These plates genuinely appear on the estate.
The watchlist *status* attached to them is synthetic; the plate is not.

| plate | camera | evidence | how it was verified |
|---|---|---|---|
| `GJ12EC7928` | `cam30` | `day_cam30_042_00` | hand-labelled, 76 px daylight — `fixtures/plate-eval/labels.json` |
| `GJ32D0107` | `cam07` | `night_cam07_111_02` | hand-labelled, 56 px streetlit — same |
| `GJ35U0779` | `cam07` | `night_cam07_102_02` | hand-labelled, 52 px streetlit — same |
| `RJ39CA5180` | `cam21` | D0-01 recon frame | human-legible in the recon frame — `docs/anpr-accuracy.md` §7 |

**That is four, not five.** D2-05's acceptance criterion asks for *"≥ 5 seeded plates verifiably
appear on the sandbox feeds"*, and the estate does not contain five verifiable registrations to
seed. D2-01 hand-labelled 120 vehicle instances across the six highest-yield cameras and found
**three** plates a human could read; the D0-01 recon survey adds one more, plus a partial
(`GJ11CH2…` on `cam06`) that is not a complete registration and is therefore not seeded. The number
is four, and it is reported as four. See `docs/anpr-accuracy.md` §2–3 for the sampling method and
its denominators.

### `estate-ocr-output` — 5 rows

Strings the ANPR pipeline **actually emitted** on the 5-minute 8-camera live run
(`docs/anpr-accuracy.md` §8). They are seeded so D2-06's alert engine can fire a real end-to-end
alert against the real estate rather than only against fixtures.

**They were selected from measured output, not from a vehicle registry.** Several are fragments
rather than registrations. Every row says so in its own `note` field.

| string | confidence | camera |
|---|---|---|
| `GJ3266416` | 0.449 | `cam07` — the only read with a plausible Indian plate shape |
| `AAM412` | 0.503 | unattributed |
| `44671` | 0.732 | `cam08` |
| `1118R` | 0.627 | unattributed |
| `46101` | 0.560 | unattributed |

**Two measured reads are deliberately excluded.** `757508300` (0.888 — the highest-confidence read
of the entire run) and `755508000` are the **phone number on a roadside advertising hoarding** on
`cam05`. Seeding them would manufacture an alert with no vehicle behind it, which is precisely the
kind of number that looks like a working demo and is not one.

### What actually produces a live hit today

| seeded plate | what the pipeline emits | recovered? |
|---|---|---|
| `GJ35U0779` | `GJ35U07` (truncated) | **yes** — fuzzy, distance 2 |
| `GJ32D0107` | `GJ32DD10` | no — distance 3, beyond the default `maxDistance=2`. D2-04's confusion-aware metric (`D→0` is a measured confusion) is what closes this |
| `GJ12EC7928` | `50011A` | no — shares not one character with the truth |
| `RJ39CA5180` | not read in the live run | n/a |
| the 5 `estate-ocr-output` strings | themselves | **yes** — exact |

So: **one ground-truth registration and five measured strings produce a hit against the live
estate**, and the ground-truth one only through fuzzy matching. Both paths are covered by tests
(`recovers the truncated read GJ35U07 → GJ35U0779 that cam07 actually produced`,
`matches a measured ANPR output string exactly`).

---

## 8 · Matching

Exact first, always, and independently of the matcher: an exact hit must never be lost because a
fuzzy candidate generator's threshold happened to exclude it.

Fuzzy matching sits behind a `PlateMatcher` interface (`packages/api/src/watchlist/matcher.ts`).
**D2-04 owns the confusion-aware weighted metric** and plugs in through
`createWatchlistRegistry({ matcher })` with no change to any file in the watchlist module.

Until then the default is `TrigramPlateMatcher`, which is the same two-stage design D2-04's plan
specifies — `pg_trgm` narrows using `watchlist_entries_plate_trgm_idx`, `levenshtein()` decides —
with two candidate generators rather than one:

- **trigram similarity** catches substitutions (`GJ01AB1234` read as `GJ0IAB1Z34`);
- **prefix**, in both directions, catches **truncation**, which D2-01 measured as this estate's
  dominant failure and which a similarity threshold tuned for substitutions can drop.

What D2-04 replaces is the *metric*, not the shape.

---

## 9 · The API

All routes require a bearer token. `operator` is **read-only on the watchlist**; `supervisor` and
`admin` may write; only `admin` may deactivate; `auditor` may read.

| method | path | role |
|---|---|---|
| `GET` | `/api/v1/watchlist` | read |
| `GET` | `/api/v1/watchlist/:id` | read |
| `GET` | `/api/v1/watchlist/providers` | read |
| `GET` | `/api/v1/watchlist/lookup/vehicle/:plate` | read |
| `GET` | `/api/v1/watchlist/lookup/person/:ref` | read |
| `POST` | `/api/v1/watchlist` | write |
| `PATCH` | `/api/v1/watchlist/:id` | write |
| `POST` | `/api/v1/watchlist/import` | write |
| `DELETE` | `/api/v1/watchlist/:id` | **admin** |

### `purpose` is required on every lookup

```
GET /api/v1/watchlist/lookup/vehicle/GJ35U0779?purpose=verifying%20alert%20A-1183&caseRef=FIR/2026/903
```

A lookup with no `purpose` is a `400`. It is not defaulted, because a default would make every
`audit_log` row say the same thing, which is the same as saying nothing. Every lookup writes one
`audit_log` row — `watchlist.lookup.vehicle` or `watchlist.lookup.person` — carrying the actor, the
purpose, the optional case reference, the normalised query and the result count, hash-linked into
the append-only chain D1-01 built and D3-04 exports.

### `DELETE` deactivates

`alerts.watchlist_entry_id` is `ON DELETE CASCADE`, so a hard delete would take every alert the
entry ever raised with it — destroying the evidence for decisions already made, which is the
opposite of what an audit chain is for. `DELETE` sets `active = false`: the entry stops matching
immediately and its history survives.

### Validity windows

`valid_from` is **inclusive**, `valid_to` is **exclusive**. An entry whose window closes at `T` does
not match at `T`. Proven at ±1 ms of both bounds by the `validity window` suite (6 tests).

`?at=<ISO>` evaluates the window at a past instant, which is how an alert is fairly reviewed after
the fact: *"would this have matched at the time of the sighting?"* is a different question from
*"does it match now"*, and only one of them is fair to the person on the list.

---

## 10 · Commissioning a real connector

1. Obtain items 1–10 of §2 for that system.
2. Implement `WatchlistProvider` against the real API in
   `packages/api/src/watchlist/<system>-provider.ts`.
3. Register it: `registry.register(new VahanProvider({ ... }))` — it replaces the mock for that
   system and leaves the other five serving.
4. Its `health()` returns `live: true`, which requires widening the `ProviderHealth.live` literal —
   a deliberate, reviewable change, so nothing can start claiming to be live by accident.
5. Point `sync()` at the delta endpoint and set the cadence from §3.
6. Nothing else changes. The routes, the matcher, the alert engine and the audit trail are unchanged.

Until step 1 is done for a given system, that system's provider is a mock and every response says so.
