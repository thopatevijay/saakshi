# Route reconstruction — method, confidence formula, and what it cannot tell you

**D3-01.** How SAAKSHI turns a list of sightings into a continuous route without pretending it knows
more than it does.

The graded test case asks for the *"complete route traversed by the designated vehicle"*. Sightings
are sparse dots. Drawing one confident polyline through them is the easy answer, and in an
evidentiary system it is the wrong one: between two cameras a vehicle could have taken any of
several roads, stopped for twenty minutes, or not been the same vehicle at all.

So this produces the continuous route the test case asks for, and keeps the two halves of it
**structurally** separate — two collections, two map layers, two vocabularies in the payload — so
that nobody can accidentally render evidence and inference the same way.

---

## 1 · What "observed" means, exactly

> **A segment is `observed` only when the movement itself was on video.**

That happens in exactly one situation: both endpoints sit on the **same camera, in the same tracking
session, with the same raw tracker id**. ByteTrack held the vehicle continuously between the two
frames, so nothing between them is inferred. Migration 0007 states the same test from the other
side — *"TRUE = both endpoints were actually seen on camera"* against *"FALSE = the path between them
is OSRM's inference"*.

`track_id` is what makes this decidable, and it is also the trap. D1-09 writes
`track_id = session_index * 100_000 + tracker_id`, and **a session ends at every scene cut and every
reconnect** — raw ByteTrack ids 1 and 2 were measured being reused across sessions 6 and 9 on
`cam03` inside a single run. Equality of the *session-qualified* `track_id` on one camera therefore
means "the track was never dropped". Comparing raw tracker ids would fuse two unrelated passes into
one continuous observation.

This is a demanding definition and it should be. On the real estate it makes **almost every
kilometre of every route inferred**, and the summary says so in the plainest words available:

> **0.0 km observed · 18.4 km inferred**

A system that reported it the other way round would be more flattering and less true.

## 2 · The four kinds, because "not observed" is not one thing

| kind | what happened | what is claimed | drawn as |
|---|---|---|---|
| `observed_dwell` | same camera, unbroken track | the movement was watched. **No distance at all** — where the vehicle went inside one field of view is not measured | solid ring on the pin |
| `inferred_path` | two placed cameras, OSRM found a path | a plausible road path, scored | dashed amber line |
| `inferred_revisit` | same camera, **different** tracking session | it left and came back; the excursion is unbounded. No distance, **not even zero** | not drawn, listed |
| `inferred_unroutable` | a camera has no coordinates, or the graph has no path | nothing | not drawn, listed |

`inferred_unroutable` is the **normal** case on this estate, not an edge case: the Sentinel catalogue
publishes `{id, name}` only, so **0 of 30 real cameras are placed** (measured independently by D1-04,
D1-08 and D2-08).

D1-08's handoff warned that D3-01 inherits the *disjoint-set* problem — the cameras anyone has
measured are exactly the ones that cannot be placed on a map — and that "neither can silently drop a
set". **Nothing here drops one.** An unplaced sighting keeps its position in the route, its segment
states why it could not be routed, `route.coverage.segmentsUnplaced` is reported beside every total,
and the screen lists every undrawn segment in a **"Not drawn · N"** tray. Nothing ever backfills a
coordinate onto a real camera; the absence is a finding and it stays one.

## 3 · The confidence formula

Only `inferred_path` segments are scored. Everything else carries `inferredConfidence: null` — there
was nothing to infer, and `1.0` would read as a measurement.

```
inferredConfidence  =  timing × uniqueness × endpoints
```

Each factor is in `[0,1]` and each is stored separately in `route_segments.confidence_basis`, so the
UI can say *why* a segment scored 0.03 rather than only that it did.

### 3.1 timing — does the elapsed time match the road?

```
r      = elapsed / expected              (expected = OSRM free-flow duration)
timing = exp( −½ · ( ln r / σ )² )       σ = 0.35 when r < 1,  1.10 when r ≥ 1
```

A log-normal bell, deliberately **asymmetric**. Arriving later than free-flow is ordinary — traffic,
signals, a stop. Arriving *earlier* than the road graph allows is close to impossible, so the narrow
fast side is what makes a near-instant transition collapse.

| elapsed | expected | r | timing |
|---|---|---|---|
| 2 s | 420 s | 0.005 | **0.000** — the vehicle would have to be in two places at once |
| 200 s | 400 s | 0.50 | 0.141 |
| 400 s | 400 s | 1.00 | **1.000** |
| 480 s | 400 s | 1.20 | 0.986 |
| 800 s | 400 s | 2.00 | 0.820 |
| 4 800 s | 400 s | 12.0 | 0.078 — an hour for a seven-minute drive; it did something else in between |

`elapsed = 0` between two *different* cameras scores **0**, not `null`: a zero gap is a real,
computable answer here.

**This is the term D3-02 inverts** to detect impossible transitions.

### 3.2 uniqueness — how forced was the path?

OSRM is asked for `alternatives=3`. `spread = bestAlternativeDuration / chosenDuration`.

```
uniqueness = 0.35 + 0.65 · min(1, max(0, spread − 1) / 0.25)
```

At `spread = 1.0` there is another way that is just as quick and the line on the map is one of
several equally good stories: **0.35**. At `spread ≥ 1.25` every alternative is materially worse and
the path is essentially forced: **1.0**. With no alternative at all: **1.0**.

It never reaches 0. One of those paths *was* taken; we simply cannot say which.

### 3.3 endpoints — how well linked are the two ends?

```
endpoints = sqrt( linkConfidence_from × linkConfidence_to )
```

The **geometric** mean, so one weak endpoint drags the segment down instead of being averaged away
by a strong one: an inference drawn between a certain sighting and a guess is a guess. Two
endpoints at 0.90 and 0.10 score **0.30**; an arithmetic mean would have said 0.50.

### 3.4 Worked example — the demo fixture, live

| # | hop | elapsed | expected | r | timing | uniq | endpoints | **conf** |
|---|---|---|---|---|---|---|---|---|
| 1 | A→A (dwell) | 45 s | — | — | — | — | — | **null** |
| 2 | A→B | 315 s | 205 s | 1.54 | 0.927 | 1.00 | 0.843 | **0.78** |
| 3 | B→C | 420 s | 270 s | 1.56 | 0.922 | 0.773 | 0.608 | **0.43** |
| 4 | C→D | 480 s | 399 s | 1.20 | 0.986 | 1.00 | 0.472 | **0.47** |
| 5 | D→A | 780 s | 669 s | 1.17 | 0.990 | 0.479 | 0.629 | **0.30** |
| 6 | A→E | 420 s | — | — | — | — | — | **null** (E unplaced) |

The three factors are doing visibly different work: hop 3 is dragged down by a weakly-linked
endpoint (a truncated plate read), hop 5 by a path with a nearly-as-quick alternative, and hops 1
and 6 are not scored at all.

## 4 · Bounds, stated in the direction they actually point

Both distances this produces are **lower bounds on the distance driven**:

- `straightLineKm` — the great-circle chord. A vehicle cannot have driven less.
- `roadDistanceKm` — OSRM's **fastest** path. A vehicle that detoured drove further, never less.

It follows that

```
minimumAverageSpeedKmh = roadDistanceKm / (elapsed / 3600)
```

is a **lower bound on the average speed**: the vehicle averaged *at least* that.

The field is named `minimumAverageSpeedKmh` rather than reusing D2-08's `impliedSpeedKmh`, whose doc
comment describes the same quantity as an *upper* bound. **`trace.segments` is left exactly as D2-08
built it** — D3-02 depends on its shape — and the discrepancy is raised on issue #25 rather than
patched here. The lower bound is the direction D3-02 needs anyway: to call a transition *impossible*
you must show that even the **minimum** speed the vehicle must have held is unreachable.

`null` always means "cannot be computed", never 0.

## 5 · Caching, and what invalidates it

Two keys, because "the same question" and "the same evidence" are different things.

| column | hashes | changes when |
|---|---|---|
| `routes.cache_key` | plate · window · `min_confidence` · `max_distance` · matcher · `MODEL_VERSION` | the question changes, or the formula does |
| `routes.sightings_fingerprint` | the ordered `(sightingId, ts)` list the trace returned | **any new sighting** lands in the window |

A hit requires **both**. So a route goes stale the instant a sighting is written, rather than when a
TTL happens to expire — which in a live investigation is the failure that matters. `MODEL_VERSION`
being in the key means a change to any constant on this page invalidates every stored route instead
of silently mixing two scoring models in one answer.

The write is **one transaction**. An earlier version inserted the `routes` row and then its
segments; a segment insert that failed left a keyed route with zero segments that every later
request served as a *hit* with an empty route. `route.test.ts` has a regression test that forces the
segment insert to fail and asserts the next request is a **miss**.

## 6 · Performance

| measure | value |
|---|---|
| p95 build, 20-sighting trace, 19 hops, 40 ms per OSRM call | **125 ms** (budget: 3 000 ms) |
| OSRM concurrency | 8 |
| live OSRM, Paldi Circle → Janpath | 2.47 km, 205 s, 43.4 km/h |

Serialising the OSRM calls is what would blow the budget; the concurrency is bounded at 8 so one
trace cannot monopolise the routing engine.

## 7 · Limitations — read this before quoting a number

1. **Nothing here identifies a vehicle.** The route inherits D2-08's identity link, and on this
   estate almost every link is fuzzy. A perfectly scored segment between two sightings that are the
   *wrong vehicle* is a confidently drawn fiction. `endpoints` is the only defence and it is a weak
   one; the claims banner above the map is the real one.
2. **The travel-time model has no traffic.** OSRM's car profile applies per-class free-flow speeds.
   Real journeys are routinely slower, which is why the timing bell is asymmetric — but it means
   `expected` is systematically optimistic, and a segment scored 0.8 at 3 a.m. and one scored 0.8 in
   the Ashram Road rush hour are not equally plausible.
3. **`uniqueness` is OSRM's opinion of alternatives, not a real path enumeration.** Three
   alternatives is a sample, not a survey. A junction-dense area with many equal routes may still
   report a high uniqueness if OSRM's alternatives happen to be poor.
4. **The road graph is a snapshot.** It is built from an OSM extract on a date. A road closed for
   works, a new flyover, a one-way reversed since the extract — all silently wrong, and nothing in
   the confidence score can see it.
5. **`observedKm` is essentially always 0.** An observed dwell has no measurable extent, so the
   observed kilometre count is zero on any estate without overlapping camera coverage. That is the
   honest number and it is stated rather than hidden — but do not read it as "the system observed
   nothing", which would be wrong: it observed every *sighting*.
6. **A road-graph distance is not the distance driven.** It is the shortest one. Summing them gives
   a lower bound on the journey, short by every unmeasured segment; the summary says so and prints
   `unmeasuredSegments` beside the total.
7. **No live VAHAN / SARTHI lookup.** Nothing here confirms that the registration belongs to the
   vehicle in the frames.

## 8 · Where the code is

| file | what |
|---|---|
| `packages/api/src/services/route.ts` | classification, the formula, the summary, persistence, cache |
| `packages/api/src/services/osrm.ts` | the road-graph client; `null` on failure, never throws |
| `packages/api/src/services/route.test.ts` | the formula's extremes, the edge cases, the cache |
| `packages/web/src/lib/trace/route-geojson.ts` | which line goes into which layer |
| `packages/web/app/(shell)/trace/route-summary.tsx` | the split, the legend, the "Not drawn" tray |
| `packages/web/scripts/verify-route.mjs` | the rendering, asserted in a real browser |
| `db/migrations/0017_route_reconstruction.*.sql` | the cache keys and the segment kinds |
| `scripts/import-osm.sh`, `docs/road-network-setup.md` | the road graph itself |

`GET /api/v1/trace?plate=…&reconstruct=true` is the contract. It is **off by default**: it costs one
OSRM query per camera-to-camera hop, and `/api/v1/trace` is also the alert queue's deep link and the
CSV/PDF export path. The `/trace` screen always asks for it, because the observed-vs-inferred
distinction is not a user preference.
