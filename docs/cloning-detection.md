# Impossible-transition detection — plate cloning, or an OCR error

**D3-02** · `packages/api/src/services/anomaly.ts` · `config/anomaly-policy.json`

A registration read at two cameras separated by more road than the elapsed time can cover is a
contradiction. Exactly one of two things happened: a camera misread a plate, or two vehicles are
wearing the same one. Vehicle cloning is widespread in India and largely undetected, because nothing
routinely cross-checks a registration against the physics of where it has been.

This document is the method, the disambiguation heuristic, the limits of both, and the counts
measured on real data — including the ones that are zero, and why.

---

## 1 · The claim this system is allowed to make

**It is not "this plate is cloned."** There is no live VAHAN or SARTHI connectivity in this project
(`CLAUDE.md`, claims discipline). Nothing here can confirm that a registration exists, that it was
validly issued, or who holds it. The strongest supportable statement is:

> These two sightings are inconsistent with a single vehicle. The most likely cause is *X*. Here is
> what else would look identical.

Every finding is served with its alternative explanation attached, and the API type makes that
structural rather than editorial: `headline`, `why`, `alternativeExplanation` and `limitations` are
all required fields, so there is no shape in which a verdict arrives without them. Two tests enforce
it mechanically — `anomaly.test.ts` scans every string the service can produce, and
`cloning-panel.test.tsx` scans what actually reaches the DOM, including labels the component adds on
its own.

---

## 2 · The method

### 2.1 The bound direction, which is the whole detector

`roadDistanceKm` comes from OSRM's **fastest** path. It is therefore a **lower bound** on the
distance actually driven — the vehicle drove *at least* that far. Two consequences, both pointing
the same way:

| quantity | what it is | direction |
|---|---|---|
| `roadDistanceKm / elapsed` (`minimumAverageSpeedKmh`) | least speed the vehicle can have held | **lower** bound |
| `expectedTravelTimeS` (OSRM free-flow) | least time the trip can have taken | **lower** bound |

A transition is called impossible only when even the **most generous** reading of the evidence
demands something unreachable. That is the direction the ticket needs; a test built on an upper bound
would flag nothing, or the wrong thing, and would look correct while doing it.

> ⚠ **D2-08's `TraceSegment.impliedSpeedKmh` documents the same physical quantity as an *upper*
> bound** and must not be used here. D3-01 named its own field `minimumAverageSpeedKmh` precisely so
> the two cannot be confused. `trace.segments` is left exactly as D2-08 built it.

**The converse is not a clean bill of health, and nothing here reports it as one.** The real road is
longer than OSRM's fastest path, so a transition can pass both tests and still not have happened.
The service's own vocabulary says so: `feasible` means *"not shown to be impossible"*.

### 2.2 The two tests

Both are in `config/anomaly-policy.json`. Failing **either** is enough; they catch different things.

```
1 · minimum_average_speed    roadDistanceKm / (elapsed/3600)  >  speed.maxPlausibleKmh
2 · faster_than_free_flow    elapsed × speed.graphSpeedTolerance  <  expectedTravelTimeS
```

- **`maxPlausibleKmh` = 140.** The fastest sustained average this detector concedes. NHAI's highest
  notified expressway limit for cars is 120 km/h and the ordinary national-highway limit is 100;
  140 sits deliberately above both, because the cost of a false "impossible" is an officer told that
  two vehicles share a registration when one of them was simply speeding. It is a physical ceiling,
  **not an enforcement threshold** — this is not a speed-enforcement tool.
- **`graphSpeedTolerance` = 1.35.** Did the vehicle beat OSRM's free-flow estimate for the *fastest*
  path by more than 35 %? Free-flow already assumes no traffic, no signals and no stops. This catches
  the short urban hop where the absolute speed stays ordinary but the road does not go that way —
  2 km in 70 s is only 103 km/h across streets the graph prices at 180 s, and only this test sees it.
- **`minElapsedSeconds` = 5** is a guard, not a tolerance, and it applies to **test 1 only** —
  the test that divides by elapsed. Test 2 never divides, so it stays available below the guard,
  which is where it matters most: two seconds against a 420-second free-flow expectation is
  impossible however coarse the clock is. (D3-01's timing term scores that same pair 0.000.)

### 2.3 What is eligible at all

Only `inferred_path` segments. `null` is load-bearing — it means *cannot be computed*, never 0.

| kind | verdict | why |
|---|---|---|
| `observed_dwell` | `indeterminate` | one camera held the vehicle in an unbroken ByteTrack session; the movement was on video |
| `inferred_revisit` | `indeterminate` | same camera, different tracking session — it left and came back, and where it went is unbounded |
| `inferred_unroutable` | `indeterminate` | a camera is unplaced, or the graph has no path |
| `inferred_path` | scored | two placed cameras, one OSRM path |

> **On the real estate `inferred_unroutable` is the normal case, not an edge case.** The Sentinel
> catalogue publishes `{id, name}` only, so **0 of 30 real cameras carry coordinates**. Treating a
> null expectation as 0 would make every one of those hops infinitely fast and manufacture cloning
> alerts out of the entire estate.

---

## 3 · The disambiguation heuristic

Once a transition is impossible, four signals separate the two explanations. Every one of them is
already measured elsewhere in this codebase rather than invented here.

| signal | source | what it means |
|---|---|---|
| OCR confidence at each end | D2-01's measured range, 0.449–0.732 | a weak read is a read that can be wrong |
| weighted distance between the two reads | D2-04's confusion metric | two reads one confusable substitution apart are one plate read twice |
| `tailChars` / truncation | D2-04 | a clean prefix is the same vehicle read badly — this estate's dominant failure |
| plate grammar | D2-03 | a string the grammar refuses is not a registration under any Indian layout |

The order of evaluation, in `disambiguate()`:

1. **Truncation dominates → `likely_misread`.** When at least half the weighted distance came from
   `tailChars` rather than substitution, the shorter read is a clean prefix of the longer one.
   D2-04 prices it at 0.35/character and measured it as this estate's most common failure.
2. **Low OCR confidence at either end, or a plausible neighbour within the budget →
   `likely_misread`**, with the neighbour surfaced as the candidate alternative.
3. **Either read fails the grammar → `undetermined`.** Not a misread verdict either: saying "misread"
   implies a correct reading exists, and `757508300` — a hoarding's phone number, and the
   highest-confidence read of the entire live run — is not a misreading of anything.
4. **Identical, confident, grammar-valid reads that *repeat* → `likely_cloned`.** Cloning is a
   standing arrangement (the same registration on two vehicles both in daily use), so it recurs; a
   single OCR accident does not. `repeatPairsForClone` = 2.
5. Otherwise **`undetermined`** — a real third state, not a euphemism for clean.

### The thresholds, and why they are not round numbers

`highOcrConfidence` = 0.75, `lowOcrConfidence` = 0.60. D2-01 read **0 plates exactly** across a
120-instance hand-labelled sample, and the five legible strings the live run produced scored 0.449,
0.503, 0.732, 0.627 and 0.56. A "high confidence" bar of 0.9 would never be met by anything this
estate produces and the clone branch would be dead code; a bar of 0.5 would call the whole estate
high-confidence. 0.75 and 0.60 straddle the measured range.

### Match-distance discipline

`maxNeighbourDistance` = **2**, and this ceiling is not raised. `docs/fuzzy-matching.md` §6 measures
`d≤2` at 99.9 % recall and **100 % precision**, `d≤3` at **91.2 %**, and `d≤4` collapsing to
**54.8 %** with unrelated plates matching. Two vehicles accused of sharing a registration because a
matcher was generous is the failure this project cannot afford. The distance is fractional, weighted
and slot-aware — never Levenshtein, never bucketed to an integer, and never rendered on its own.

---

## 4 · The alert, and why it is not in the `alerts` table

Cloning suspicion is escalated as **its own alert type** (`kind: 'cloned_plate_suspected'`), carried
on the trace payload rather than written to `alerts`.

`alerts` is watchlist-scoped — `watchlist_entry_id` is `NOT NULL` — and it says *"this vehicle is
wanted"*. A cloning finding says *"these two sightings cannot both be one vehicle"*. Different claim,
different evidence, different action. Filing it in the operator's watchlist queue would put an
accusation where a match belongs, and would require making a watchlist entry optional on a table four
other tickets depend on.

Two guards on escalation, both config:

- **`alert.severity`** = `medium` by default. Deliberately not `high`: D2-06's rule applies unchanged
  — a severity is never *raised* by a model's opinion.
- **`alert.minLinkConfidence`** = 0.5. D2-08 measured mean link confidence for recoverable reads at
  **0.34–0.59**. A finding built on two links at 0.34 is two possibilities, not two identifications.
  Below the floor the finding is still reported; it is simply not escalated.

The `route_segments.anomaly` column (`none` | `impossible_transition`, migration 0007) is written
per segment so SQL sees the same verdict the API does. The *reasoning* is not stored: it is a
function of the policy file, and a stored explanation would go stale the moment that file changed.
For the same reason the verdict is **recomputed on a cache hit** rather than served from the cached
route — the acceptance criterion is that changing the speed tolerance moves the boundary with no code
change, and a verdict frozen into a cache would keep the old boundary until the cache expired.

---

## 5 · Measured on real data

`npm run analyze:anomalies` sweeps every plate the estate has actually read
(`plate_reads.normalized_text <> ''`, **never** `is not null` — D2-10: an empty string is a real row
with real timing carrying *no identity*, and `is not null` would manufacture "clones" out of blank
reads). Totals are deduplicated by sighting pair, because several distinct reads of one vehicle —
`GJ01AB1234`, `GJ01A81234`, `GJ01AB12`, `GJ01AB123` — all fuzzy-resolve to the same identity and
would otherwise contribute the same transition four times.

### 5.1 The real estate: 0 impossible transitions, and 0 that could be tested

Run on `saakshi_d3_02`, migrated to 0022 and seeded with the 30-camera estate, against a live OSRM
graph of Gujarat:

```
the estate, measured
  cameras             30 (0 with coordinates)
  sightings           0
  plate reads         32 (32 carrying an identity)

the sweep
  plates swept        6
  traced (>= 2 hits)  0
  segments examined   0   <- distinct transitions, deduplicated by pair
  segments evaluable  0   <- a road distance and a usable elapsed time

classification
  impossible          0
```

(The 32 plate reads with 0 sightings are orphans left by the test suite: `plate_reads` carries no
foreign key to `sightings`, because `sightings` is a TimescaleDB hypertable — the note in migration
0005 says so. None of them traces to two sightings, which is why 0 plates were traced.)

**The honest reading, and the sweep prints it itself:** there is nothing here to measure. Two
independent facts each make the detector unable to fire on the real estate as it stands:

1. **The sightings table is empty.** No ingest run has been held against this database.
2. **Even with sightings, 0 of 30 cameras carry coordinates.** Every real transition would be
   `inferred_unroutable`, no distance would be computable, and every verdict would be
   `indeterminate`. D2-08 predicted exactly this in its handoff on issue #25.

"0 impossible transitions" here means **"0 transitions were testable"**, not "the estate is clean",
and the sweep says so in those words rather than printing a reassuring zero. Impossible-transition
detection cannot fire on this estate until the camera catalogue carries positions.

### 5.2 The detector itself, exercised end to end

To show the pipeline works — road graph, trace, reconstruction, classification, alert, view — the
trace fixture seeds a clearly-labelled synthetic second vehicle wearing the same registration:

```
npm run demo:trace -w packages/api -- --seed --clone
npm run analyze:anomalies -- --seq
```

```
the estate, measured
  cameras             35 (4 with coordinates)
  sightings           11
  plate reads         22 (22 carrying an identity)

the sweep
  segments examined   10   <- distinct transitions, deduplicated by pair
  segments evaluable  7

classification
  impossible          2
    likely misread    0
    likely cloned     2
    undetermined      0
  cloning alerts      2
```

The two flagged transitions are `TRACEFIX-CAM-D → TRACEFIX-CAM-A` **30 seconds apart** over **9.24 km
of real Ahmedabad road** that OSRM prices at **669 s** free-flow — a minimum average of
**1,109 km/h**. Both reads are exact and confident (0.86, 0.84), grammar-valid, and the pattern
repeats an hour later, so the misread branch is unavailable and the clone branch is reached.

**This is a fixture and must never be quoted as an observation.** It is synthetic by construction,
seeded only behind `--clone`, removed by `--remove`, and it exists because the measured corpus
contains no pair of placed cameras with a plate read at both.

The same result through the real endpoint, with a stated purpose and a supervisor's bearer token
(`GET /api/v1/trace?plate=GJ01AB1234&purpose=…&reconstruct=true`, HTTP 200):

```
examined 10 evaluable 7 impossible 2 cloned 2 alerts 2
seq 8   likely_cloned  30s over 9.244km (free-flow 669s) => min 1109.3 km/h
        failed=[minimum_average_speed,faster_than_free_flow]  severity=medium
        left:  HTTP 200 image/jpeg 1182 bytes
        right: HTTP 200 image/jpeg 2864 bytes
seq 10  likely_cloned  (same pair, one hour later)
```

Both crops on the alert resolve to real JPEG bytes through their presigned object-store URLs —
D2-11's rule that no path signs a URI it cannot serve, checked on this one too.

**Note what the sweep does *not* show: `likely misread 0`.** The fixture's cloned leg is exact and
confident at both ends by construction, so the misread branch is never reached by it. That branch is
covered by tests instead, on the estate's own measured reads — `GJ35U0779` at 0.732 against
`GJ35U07` at 0.503 (truncation), `GJ01AB1234` against `GJ01A81234` (the B/8 confusion), and an
identical pair with one read at 0.449.

### 5.3 What a real deployment should expect to see first

If this detector is ever run on a populated, placed estate and the impossible rate comes back high,
**read it as an OCR-quality or clock finding before reading it as cloning.** The sweep flags any rate
above 20 % of assessable transitions and says so in its own output. Two mundane causes produce this
exact signature with no vehicle doing anything:

- **A camera whose presentation clock is wrong.** All timing here is PTS-derived wall clock; a camera
  five minutes out will contradict its neighbours forever.
- **A mis-tracked pass.** D3-03 measured **21 % of ByteTrack passes not holding a single vehicle** —
  9 identity switches and 7 unadjudicable out of 75, two of which were roadside lettering rather than
  vehicles. Two vehicles joined into one sequence look exactly like one vehicle in two places.

---

## 6 · Limits, stated plainly

1. **No registry link.** No VAHAN, no SARTHI. A finding cannot be checked against whether the
   registration exists or who holds it.
2. **The road distance is the fastest path**, not the road taken, so `feasible` is "not shown to be
   impossible" and never a verification. A transition cleared here may still not have happened.
3. **The clock is the video's, not the world's.** A camera with a wrong presentation timestamp
   produces impossible transitions with no vehicle involved.
4. **Each link to the registration is itself a match, not a certainty.** On this estate almost every
   link is fuzzy; the geometric mean of the two endpoints' link confidences is on every finding, and
   the alert floor is set against D2-08's measured 0.34–0.59 range.
5. **Precision has not been measured on real data**, because there is no real data to measure it on
   (§5.1). No precision figure is claimed anywhere in this project for cloning detection, and none
   should be quoted until a populated, placed estate exists to measure against.
6. **A repeated pattern is required for a clone verdict**, so a genuine single-instance clone will be
   reported as `undetermined` rather than as cloning. That is a deliberate trade: the cost of a false
   cloning verdict is higher than the cost of an honest "cannot tell".

---

## 7 · Files

| what | where |
|---|---|
| the detector | `packages/api/src/services/anomaly.ts` |
| the policy | `config/anomaly-policy.json` |
| tests | `packages/api/src/services/anomaly.test.ts` (28), `packages/web/src/lib/trace/cloning-panel.test.tsx` (8) |
| the sweep | `packages/api/src/jobs/analyze-anomalies.ts` — `npm run analyze:anomalies` |
| the view | `packages/web/app/(shell)/trace/cloning-panel.tsx` |
| the fixture | `packages/api/src/demo/trace-fixtures.ts` — `--seed --clone` |
| the travel-time model this inverts | `packages/api/src/services/route.ts`, `docs/route-reconstruction.md` |
| the match metric | `packages/api/src/services/plate-search.ts`, `docs/fuzzy-matching.md` |
