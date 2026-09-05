# The retention / evidence clock — model, arithmetic, and the limits of the claim

> **D3-05.** What an investigating officer asks first, and what nobody in Gujarat can currently
> answer: *what footage can I still get, and how long do I have?*

The problem statement says it plainly — *"some systems storing footage for 7 days and others for 15
days or more"* — and the consequence is not obvious until it costs a case. Evidence does not announce
its own expiry. A crime reported on day 12 is investigated against footage that may already have been
overwritten on eight cameras and be safe on two, and there is no place to look it up. The retention
clock is that place.

---

## 1 · The model, stated exactly

**Footage recorded at `t` on a camera whose department declares `retentionDays` is overwritten at
`t + retentionDays × 24 h`.**

That is a *rolling window* on the recorder. Two other regimes exist in the field and this is not
them:

| regime | what it means | why we do not report it |
|---|---|---|
| **rolling window** ✅ | Every frame survives exactly N days from when it was recorded. | This is what a stated "retention_days" figure describes, and it is what departments answer with. |
| end-of-Nth-calendar-day | Everything from a day is dropped together at midnight on day N. | Nothing in the registry distinguishes it, and guessing would move the deadline by up to a day. |
| quota-driven | The recorder overwrites when the disk fills, not when the clock runs out. | Common on older NVRs, and it makes the *declared* figure a ceiling rather than a promise. Stated as a limit in §6, not modelled. |

The implementation is `packages/shared/src/retention.ts`. It is pure, it is shared between the API
and the web app, and it is boundary-tested in `packages/shared/src/retention.test.ts` — one
implementation, because two copies of a countdown eventually disagree in front of somebody relying on
one of them.

## 2 · The four states

| state | meaning | how it is reached |
|---|---|---|
| `available` | Within the declared window, outside the warning threshold. | `remaining > threshold` |
| `expiring_soon` | Inside the warning threshold. Act now. | `0 < remaining ≤ threshold` |
| `expired` | Past the declared window. Probably overwritten. | `remaining ≤ 0` |
| `unknown` | **The department declared no retention period.** Nothing can be said either way. | `retention_days IS NULL` |

Both boundaries are **inclusive and lean toward warning the officer**:

- At exactly `expiresAt`, the state is `expired` — a recorder that keeps 7 days has, at the 7-day
  mark, already overwritten it.
- At exactly the threshold (48 h remaining, 48 h threshold), the state is `expiring_soon`.

`retentionDays: 0` is a real, declarable answer — *"we keep nothing"* — and expires the footage at the
instant it was recorded. It is deliberately distinct from `null`, which is *"we did not say"*.

## 3 · Why IST is named in the acceptance criterion

India Standard Time is **UTC+05:30 with no daylight saving**, and has been since 1945. That is what
makes "add 24 hours" and "add one calendar day" the same operation here. The same countdown built in
a DST jurisdiction would be an hour wrong twice a year — at exactly the boundary where somebody is
asking whether evidence still exists.

The offset is applied arithmetically (`istDate`, `istMidnight`, `istCalendarDaysBetween`) rather than
through `Intl` or a `TZ` lookup, so the answer cannot change with the host's tzdata or locale build.

Calendar days matter as well as elapsed hours, because the officer's question is a calendar one:
23:55 IST and 00:05 IST are ten minutes apart and **one calendar day** apart, and "is that Tuesday's
footage?" is answered by the second number. `istCalendarDaysBetween` is that answer;
`remainingDays` / `remainingHours` are the elapsed one. Both are exposed and neither is derived from
the other.

## 4 · `unknown` is never a default

D1-05's rule, inherited through D1-06: **an unmeasurable value must never be scored as a bad one.**

A camera whose department never declared a retention period is `unknown` — not 7 days, not 15, not
expired. The `unknown` status carries `expiresAt: null`, `remainingMs: null`, `remainingDays: null`
and `expiresOnIstDate: null`, so a caller cannot read a number that was never measured.

The reason is operational, not stylistic. **An officer told "expired" stops looking.** An officer
told "we do not know — ring the owning department" makes the call, and the footage may well still be
there. The legend says exactly that, in those words, and a test asserts the sentence.

In the UI, `unknown` is drawn with a **dashed** chip — a different *shape*, not a paler shade of the
bad colour, following D1-08's rule for never-probed cameras. `retention.test.ts` in
`packages/web/src/lib/evidence` asserts that no other state is dashed.

## 5 · What the estate actually says today

Measured on `saakshi_d3_05`, the 30-camera Gujarat sandbox estate:

```sql
saakshi_d3_05=# select retention_days, count(*) from cameras group by 1 order by 1;
 retention_days | count
----------------+-------
                |    30      ← every one NULL

saakshi_d3_05=# select count(*), count(location), count(department_id) from cameras
                 where deleted_at is null;
 30 | 0 | 0
```

**No camera on this estate declares a retention period, a position, or an owning department.** The
upstream `GET /api/ingest` publishes a bare `[{id, name}]` array (D1-04 measured this: *"every
`declared_*` column is therefore NULL"*).

This is not a gap in the feature. **It is the feature's thesis, measured.** The reason nobody in
Gujarat can tell an officer what footage still exists is that the catalogue does not carry the two
fields the question needs. The estate view says so on screen, in words, rather than showing an empty
bar chart and letting a viewer infer something kinder.

The API's own behaviour follows from it: a location query against this estate returns **zero covering
cameras and thirty unassessable ones**, every one of them `unknown`. Which is the honest answer, and
is why `unassessable` is a first-class part of the payload rather than a filtered-out remainder.

## 6 · What this is NOT — the limits, stated before anyone asks

1. **A retention state is computed from a declared policy, not from an inspection of the recorder.**
   SAAKSHI holds no connection to any department's NVR, VMS or cloud storage, and reads no disk. A
   camera reported `available` may have failed and recorded nothing; one reported `expired` may still
   hold the footage if its recorder is quota-driven rather than clock-driven. `RETENTION_DISCLAIMER`
   says this on every response that carries a state.

2. **A preservation request does not extend retention.** It cannot. `PRESERVATION_DISCLAIMER`, which
   the API returns and the UI renders verbatim:

   > A preservation request is an instruction to the owning department, recorded and audited here. It
   > does NOT extend retention automatically: SAAKSHI does not operate the recorder and cannot stop
   > it overwriting. The owning department must act on this request before the expiry shown.

   This is the single most tempting over-claim in the build. A screen headed "Preservation" that let
   an officer believe the footage was now safe would be worse than not having the screen: they would
   stop chasing the department. So the sentence is a constant, imported and never paraphrased, and
   tests assert it appears in the create response, on the queue, and on the page.

3. **Coverage is proximity, not a viewshed.** A camera is reported as covering a location when its
   registered position is within the radius. `camera_coverage` exists in the schema with a `viewshed`
   polygon, and nothing populates it for this estate. A camera listed may have been pointing away; one
   just outside the radius may still have seen the incident. The payload carries
   `coverageModel: 'proximity'` and the sentence explaining it, so a screenshot carries the
   qualification.

4. **No live registry connectivity anywhere in this feature.** No VAHAN, SARTHI, eGujCop, AFIS or
   NAFIS. No biometric processing. The retention clock reads `cameras.retention_days` from SAAKSHI's
   own registry and nothing else.

## 7 · What the department must do

The clock's value is that it turns a silent deadline into an addressable one. The workflow it
supports, and the part of it SAAKSHI cannot do:

| step | who | where |
|---|---|---|
| 1. See that footage covering a place and time expires in N hours | officer | `/evidence` |
| 2. Record a preservation request against a case reference | officer (supervisor or admin role) | `POST /api/v1/evidence/preservation` |
| 3. The act is appended to the tamper-evident chain | SAAKSHI | `audit_log`, action `evidence.preservation_request` |
| 4. The request appears on a queue, most urgent first | SAAKSHI | `GET /api/v1/evidence/preservation` |
| 5. **Actually hold the footage** | **the owning department** | **their recorder — outside SAAKSHI entirely** |
| 6. Report back what was done | department, relayed by a supervisor | `preservation_requests.status` |

Step 5 is the one that matters and the one SAAKSHI does not perform. What it provides is a request
that is timestamped, attributed, bound to a case, and impossible to alter afterwards without the
chain saying so — which is what makes it something an evidence process can rely on rather than a
phone call somebody remembers differently.

The **most valuable thing a department can do** to make this feature work is smaller than any of the
above: **declare `retention_days` and a position for each camera.** Two fields per camera turns thirty
`unknown`s into thirty answers.

## 8 · The API

```
GET  /api/v1/evidence/availability      registry:read
       ?lat= &lon= &radius_m= [&at=] [&expiring_soon_hours=] [&department_id=]
     → { query, coverageModel, coverageModelNote, covering[], unassessable[], counts, legend, disclaimer }

GET  /api/v1/evidence/retention/summary registry:read
     → { totalCameras, declared, undeclared, shortestDeclaredDays, longestDeclaredDays,
         buckets[], byDepartment[], located, unlocated, disclaimer }

POST /api/v1/evidence/preservation      registry:write   (an auditor deliberately cannot)
       { cameraId, windowStart, windowEnd, caseRef, purpose, notes? }
     → 201 { request, auditHash, disclaimer }

GET  /api/v1/evidence/preservation      registry:read
       [?status=] [&case_ref=] [&camera_id=] [&limit=] [&expiring_soon_hours=]
     → { data[], limit, counts, disclaimer }
```

`RetentionStatus`, on every camera, sighting and alert that carries one:

```ts
{
  state: 'available' | 'expiring_soon' | 'expired' | 'unknown';
  retentionDays: number | null;      // null = the department declared none
  expiresAt: string | null;          // ISO; null when state is 'unknown'
  remainingMs: number | null;        // negative once expired
  remainingDays: number | null;      // magnitude; sign carried by state
  remainingHours: number | null;     // 0-23, within the final day
  expiringSoonHours: number;         // the threshold this was judged against
  computedAt: string;                // a status is a snapshot, and it says when
  expiresOnIstDate: string | null;   // YYYY-MM-DD, IST
  label: string;                     // '4d 6h left' | 'expired 2d ago' | 'retention not declared'
}
```

### Where the clock appears

- **`/evidence`** — the availability search, the estate distribution, the preservation queue.
- **The alert queue and detail** — `GET /api/v1/alerts` and `/alerts/:id` carry `retention`, computed
  against the alert's **first** sighting: the oldest footage the alert covers, and so the first part
  to be overwritten. Timing from `lastSeenAt` would report an alert as safe while the approach — the
  usually-useful part — had already gone.
  `retention: null` on an alert means *not computed on this delivery path*: the live SSE frame is fed
  by the engine at raise time and does not read the registry. It is distinct from `state: 'unknown'`,
  and the clock arrives with the next list read.
- **The trace timeline** — every sighting carries its own `retention`. Per sighting, not per trace: a
  trace can span days, and two sightings on the same camera are on two different clocks.

## 9 · Configuration

| knob | default | where |
|---|---|---|
| `RETENTION_EXPIRING_SOON_HOURS` | `48` | `.env` — the deployment-wide warning threshold |
| `?expiring_soon_hours=` | the deployment default | per query, on availability and on the queue |
| `cameras.retention_days` | `NULL` | per camera, from bulk import, manual entry or the onboarding API |

48 hours is a working figure, not a law: two working days is about the shortest notice on which a
request to another department can realistically be actioned. A district with a slower evidence desk
needs a longer fuse, which is why the knob exists at both scopes.

## 10 · Storage

`preservation_requests` (migration `0020`) records, per request: the camera, the wall-clock window,
the case reference, the stated purpose, who asked and when, the status, **the retention figures as
they stood at the moment of the request**, and the `audit_log.hash` of the chain entry that
authorised it.

The snapshot matters: if a department later corrects its declared retention from 7 days to 15, the
queue must still show what the officer was told when they acted, or the record stops explaining the
decision it exists to explain. The live figure is always recomputable from `cameras.retention_days`;
the historical one is not.

`audit_hash` is a pointer *into* D3-04's chain, deliberately not a foreign key — the chain is
append-only and hash-addressed, and a FK would let a cascade reach it. Verifying the pointer is a
chain-verification concern, not a constraint.

## 11 · Reproducing any of this

```bash
DATABASE_URL=… npm run test -w packages/api -- retention        # 46 tests: the clock and the endpoints
DATABASE_URL=… psql "$DATABASE_URL" -c \
  "select retention_days, count(*) from cameras group by 1 order by 1;"   # the hand-check
```

The endpoints require a bearer token — every read route has since D1-02 established the RBAC matrix.
`packages/api/src/routes/retention.test.ts` exercises all four through `app.inject()` with real
tokens for all four roles.
