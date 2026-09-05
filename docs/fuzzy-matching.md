# Confusion-aware fuzzy plate matching

**D2-04 (#18).** How SAAKSHI finds a vehicle when the camera did not read its plate correctly — the
metric, the confusion matrix, where the matrix came from, and the measured precision and recall of
the *matcher* (which is a different question from the accuracy of the OCR, `docs/anpr-accuracy.md`).

> Every number in this document was produced by a command you can re-run. Where a number is worse
> than we would like, it is here anyway. Nothing in this file is an estimate.

---

## 1 · Why this exists

On the sandbox estate, exact plate matching finds nothing.

| measurement | value | source |
|---|---|---|
| exact plate accuracy | **0%** | D2-01, 120 hand-labelled vehicle instances |
| character accuracy | **51.8%** | same |
| human-legible plates in the labelled set | **3 of 120** | `docs/anpr-accuracy.md` §3 |

A jury hands us a registration on evaluation day. A system that answers "no results" has told the
truth and been useless. The job of this module is to return **ranked candidates with an honest
distance attached**, and to return *nothing* when the string it was given cannot be a registration.

The two failures this estate actually makes:

1. **Confusable substitutions** — `0/O/D`, `1/I/L`, `8/B`, `5/S`, `2/Z`, `6/G`, `4/A`, `7/T`, plus
   the letter-to-letter ones D2-05 measured (`C→F`, `D→B`, `E→F`).
2. **Trailing truncation** — the dominant failure here. `GJ35U0779` is read `GJ35U07`; `GJ12EC7928`
   is read `50011A`.

Truncation is **not** a run of substitutions, and a metric that bills it as one loses the case it
exists for. That distinction is the single most important idea in this module.

---

## 2 · The metric

A weighted Levenshtein distance over the normalised (`[A-Z0-9]`) forms.

```
cost(substitute candidate[i] → query[j])
    = 2.5                                    if i ≤ 1, the pair crosses alpha/digit,
                                             and the query has no letter at index 0 or 1
    = pairCost(a, b) × positionWeight(slot(i))   if the pair is in the matrix
    = 1.0 × positionWeight(slot(i))              otherwise

cost(insert / delete, mid-string)  = 1.0

cost(delete a trailing character)  = 0.35, for up to `tailAllowance` (2) characters
                                     at one end only; the third and later cost 1.0
```

The trailing rule is applied by taking the minimum over all one-sided trims of up to
`tailAllowance` characters, so the answer is `min(a) [ levenshtein(query, candidate[0 : n−a]) +
a × 0.35 ]` and the mirror image for a query with extra characters. **One side only**: trimming both
tails at the cheap price would model a trailing *substitution* as two cheap deletions
(`GJ01AB1234` vs `GJ01AB1237` at 0.70 rather than 0.80) and invert the ordering AC 3 requires.

`slot(i)` comes from D2-03's parse of the candidate (`validate().parts`), falling back to
`unparsed` — weight 1.0 — rather than guessing.

### What it does to the cases that matter

| query | candidate | plain `levenshtein()` | weighted | why |
|---|---|---|---|---|
| `GJ35U07` | `GJ35U0779` | 2 | **0.70** | 2 truncated characters, not 2 substitutions |
| `GJ32DD10` | `GJ32D0107` | 2 | **0.55** | one measured confusion (`D↔0`) + 1 truncated character |
| `GJ01AB1Z34` | `GJ01AB1234` | 1 | **0.36** | `2↔Z`, in the number slot |
| `GJ01AB1X34` | `GJ01AB1234` | 1 | **0.80** | not a confusable pair — deliberately dearer |
| `757508300` | `TS75O8300` | 3 | **> 4** | a state code may be misread, never invented |
| `GJ35` | `GJ35U0779` | 5 | **3.70** | beyond the tail allowance, so a real deletion again |

Plain levenshtein calls the first two cases the same thing — "two characters wrong" — and at
`max_distance = 2` it cannot separate either of them from a genuinely unrelated plate sitting at its
own limit. Turning "2" into "0.55" and "0.70" is what makes a *ranking* possible.

### The ranking score

```
matchStrength  = 1                                  if distance == 0
               = max(0, 1 − distance / (max_distance + 1))   otherwise
score          = matchStrength × ocrConfidence
```

A flat product of two independent, auditable factors — the rule D2-03's confidence model follows,
for the same reason: a single tuned number cannot be argued with in front of a jury, and this one
can be recomputed by hand from the response body. Watchlist entries carry no OCR confidence, so
there `ocrConfidence` is 1 and the score is the match strength.

---

## 3 · The confusion matrix, and where every row of it came from

`config/plate-confusions.json`. Read from disk at runtime, never imported, so **a cost change alters
ranking with no rebuild** — the same rule `config/trust-weights.json` follows. Every pair carries a
`source` field, and there are only four kinds:

| source | count | cost | what it means |
|---|---|---|---|
| `measured` | 4 | 0.25 | Observed on this estate's own output: `C→F`, `D→B`, `E→F`, `0→D`. n is small — see §8. |
| `derived-cross-class` | 12 | 0.45 | Taken from D2-03's `ALPHA_TO_DIGIT` / `DIGIT_TO_ALPHA` and their `alternatives`. A glyph pair the corrector will repair is a pair the search must be willing to cross. |
| `derived-alpha-bridge` | 5 | 0.45 | Two **letters** are confusable when `ALPHA_TO_DIGIT` maps them to the same digit: `O/D/Q` all read as `0`, `I/L` both as `1`, `G/B` both as `6`. |
| `closure` | 1 | 0.45 | `C` and `E` are both measured as read `F`, so they are confusable with each other. |

**The alpha-to-alpha rows are the ones only this ticket could add.** D2-03's corrector is slot-aware
and therefore structurally blind to them: `C→F` never changes a character's class, so no slot
constraint is ever violated and nothing is ever repaired. They had to come from measurement plus the
bridge rule above.

### Position weights

| slot | weight | why |
|---|---|---|
| `state` | 1.6 | Two letters, the strongest disambiguator, and the part an operator can usually read. |
| `rto` | 1.0 | |
| `series` | 0.9 | |
| `number` | 0.8 | The most-degraded region: D2-01 measured trailing errors and truncation as this estate's dominant failure. |
| `unparsed` | 1.0 | No parse, no opinion. |

### What is deliberately **not** modelled

**No digit-to-digit confusion.** None was measured on this estate, and none is derivable from the
D2-03 correction maps — no two digits share a letter in `DIGIT_TO_ALPHA`. `1/7` and `5/6` are
plausible on other estates and on other fonts; they are absent here because adding them would be an
accuracy claim without a measurement. This is a known gap and it is why `1` and `7` are charged the
full 1.0 against each other.

---

## 4 · The asymmetry, and why it is not a bug

D2-03's corrector never touches the state code, because symmetric digit↔letter correction turns
`757508300` — a roadside hoarding's phone number, and the **highest-confidence read of the entire
live run** — into `TS75O8300`, a structurally perfect Telangana registration. That asymmetry has to
survive into the search layer, or the search layer reintroduces the failure the corrector avoided.

Three guards do it:

1. **Refusal.** A query whose primary D2-03 rejection code is `no_letters`, `no_digits`, `empty` or
   `too_short` is **not searched at all**. `757508300` never reaches a query.
2. **The state anchor.** When the query carries a *recognised* RTO code, candidate generation is
   restricted to plates whose first two characters are that code or a single alpha↔alpha confusable
   variant of it (`GJ` → `{GJ, BJ}`). When the state code is itself unreadable there is nothing to
   anchor on, so the anchor is dropped and guard 3 carries the precision instead.
3. **The invention guard.** A cross-class substitution at index 0 or 1 costs 2.5 — out of reach of
   any usable `max_distance` — **whenever the query has no letter of its own in those positions**.

Guard 3 is narrower than "no cross-class substitution in the state code", and deliberately so: the
blanket rule would also lose `6J18Y9407 → GJ18Y9407`, a legitimate `G↔6` confusion that AC 2
requires us to find. The rule that survives both is: **a state code may be misread; it may not be
invented out of digits.**

---

## 5 · Not searching is an answer

`GET /api/v1/plates/search` returns `searched: false` with the grammar's own reason code rather than
fuzzing a string that cannot be a plate.

```json
{ "query": "757508300", "normalized": "757508300", "validity": "invalid",
  "reason": "no_letters", "searched": false, "candidates": [] }
```

Measured on the fifteen strings D2-01's live run actually emitted (`docs/plate-grammar.md` §8), nine
are refused outright on `no_letters` or `too_short`. The right number of results for a hoarding's
phone number is zero, and the system says so with a reason instead of silently returning nothing.

---

## 6 · Measured precision and recall — of the *matcher*

**This is not an OCR accuracy claim.** It measures one thing: given a string that differs from a
watchlist plate in a known way, does the matcher find that plate, and what else does it return?

**Corpus:** the 235-entry watchlist SAAKSHI ships (`fixtures/watchlist-seed.csv`, loaded by
`npm run seed:watchlist`), of which **115 distinct plates** have an open validity window at the
instant of the query. The 12 plates behind a closed window are unreachable by design and are
excluded from the denominator; counting them would understate recall by ~10% for a reason that has
nothing to do with matching.

**Queries:** generated by perturbing each corpus plate in each of six ways, discarding any
perturbation that collides with another real corpus plate.

| failure family | n | `d≤1` before | `d≤1` after | `d≤2` before | `d≤2` after |
|---|---|---|---|---|---|
| 1 confusable substitution | 783 | 100.0% | 100.0% | 100.0% | 100.0% |
| 2 confusable substitutions | 221 | **0.0%** | **80.5%** | 99.5% | 99.5% |
| truncation −1 | 112 | 100.0% | 100.0% | 100.0% | 100.0% |
| truncation −2 | 111 | **0.0%** | **100.0%** | 100.0% | 100.0% |
| truncation −3 | 111 | **0.0%** | **0.0%** | **0.0%** | **100.0%** |
| 1 substitution + truncation −1 | 111 | **0.0%** | **100.0%** | 100.0% | 100.0% |

"before" is D2-05's shipped `TrigramPlateMatcher` (`pg_trgm` + plain `levenshtein()`); "after" is
this module. **Precision was 100.0% for both matchers in every cell of that table.**

Two honest readings of it:

- **At `max_distance = 2` the two matchers agree on everything except three-character truncation.**
  A single confusable substitution is plain edit distance 1 and plain levenshtein finds it perfectly
  well. This ticket did not rescue those cases; it was never going to.
- **What it actually buys is the same recall at half the distance budget.** Everything plain
  levenshtein needs `d≤2` for, the weighted metric delivers at `d≤1` — and `d≤1` is the setting at
  which the *unrelated* plates stay out. That is a precision-preserving widening, not a widening.

### What widening costs

All six families pooled (1,449 queries), against the same 115-plate corpus, plus 15 deliberately
unrelated queries (registrations from states with no corpus presence, and the measured non-plates):

| `max_distance` | recall | precision | rows returned | rows for the 15 unrelated queries |
|---|---|---|---|---|
| 0.5 | 55.8% | 100.0% | 808 | 0 |
| 1.0 | 89.4% | 100.0% | 1,295 | 0 |
| 1.5 | 92.3% | 100.0% | 1,337 | 0 |
| **2.0** | **99.9%** | **100.0%** | **1,448** | **0** |
| 2.5 | 99.9% | 97.4% | 1,487 | 0 |
| 3.0 | 99.9% | 91.2% | 1,588 | 0 |
| 4.0 | 99.9% | 54.8% | 2,641 | **3** |

**2.0 is the knee, and it is the default for that reason and no other.** Above it recall stops
improving and precision falls off a cliff: at 4.0 nearly half of everything returned is wrong and
unrelated plates start matching. A matcher that finds `GJ32D0107` by also matching forty innocent
vehicles is worse than one that finds nothing, so the default sits where the last cell with 100%
precision is.

### The negative set

Fifteen queries that must return nothing — `757508300`, `755508000`, `44671`, `41111`, `46111`,
`15144`, `7`, `CIRCLE`, and seven valid registrations from states the corpus does not contain.

| matcher | rows returned at `d≤2` |
|---|---|
| `trigram+levenshtein` (before) | 1 |
| `confusion-weighted` (after) | **0** |

The one "before" row is `44671` matching the seeded `estate-ocr-output` string `44671` — a real
exact match, not an error, but a query the grammar says is a phone number and should never have been
fuzzed. The exact-match path in `MockProvider.lookupVehicle` still returns it; the *matcher* now
declines to guess about it.

Reproduce: `npm run test -w packages/api -- plate-search`.

---

## 7 · Performance

`npm run bench:plate-search`. Corpus: **250,001 plate reads** over 250,000 sightings across 40
cameras and 30 days — an order of magnitude more than the 5-minute 8-camera live run produces, so
the number is a ceiling rather than a flattering best case.

| scenario | p50 | p95 | p99 | rps |
|---|---|---|---|---|
| exact (`max_distance=0`) | 17 ms | 22 ms | 29 ms | 219 |
| fuzzy `d=1` | 17 ms | 21 ms | 23 ms | 222 |
| fuzzy `d=2` | 18 ms | 21 ms | 28 ms | 214 |
| **truncated `d=2`** (slowest) | 90 ms | **93 ms** | 118 ms | 44 |
| miss `d=2` | 1 ms | 2 ms | 4 ms | 2,261 |
| fuzzy `d=2` + 7-day window | 18 ms | 20 ms | 21 ms | 218 |

**Worst p95: 93 ms against a 500 ms target,** at 4 concurrent connections.

Four, not five hundred, and the reason is stated rather than assumed: *"p95 < 500 ms"* is a latency
target and *"N concurrent users"* is a throughput one, and reporting one as the other is how a
benchmark lies. Four is a realistic number of control-room operators searching at the same instant.
Where it degrades is printed on every run:

| connections | p50 | p95 |
|---|---|---|
| 1 | 77 ms | 89 ms |
| 4 | 89 ms | 100 ms |
| 8 | 138 ms | 182 ms |
| 16 | 235 ms | 317 ms |
| 32 | 561 ms | **1,297 ms — over target** |

### Two performance findings worth recording

**1 · `$query LIKE column || '%'` cannot use an index.** D2-05's truncation probe put the column on
the *right* of the `LIKE`, which is a sequential scan of every row on every query. Over the 235-row
watchlist that is invisible. Over 250,000 plate reads the first benchmark measured a p95 of
**6,178 ms** against a 500 ms target. The fix is to enumerate the query's own truncated prefixes
(at most `tailAllowance` = 2 of them) and ask an **equality** question against
`plate_reads_normalized_exact_idx` instead. Same question, indexable form.

**2 · The `pg_trgm` similarity floor is worth 3× on its own.** D2-05 set it to 0.2 because its
truncation probe needed the slack. With truncation now covered by its own indexed prefix probes, the
floor only has to cover *substitutions*, and it can sit at pg_trgm's own 0.3 default:

| floor | one truncated query at 250k rows | candidates before ranking |
|---|---|---|
| 0.20 | 304 ms | 8,048 |
| **0.30** | **108 ms** | **426** |
| 0.45 | 6 ms | 2 |

0.45 is tempting and wrong: `similarity('GJ32DD10', 'GJ32D0107')` is **0.357**, so 0.45 loses the
exact case this ticket exists to recover. 0.30 keeps it with margin, and re-running §6 at 0.30 gives
recall and precision identical to 0.20 in every cell. The value and this reasoning live in
`config/plate-confusions.json` beside the number.

**No migration was needed.** `plate_reads_normalized_trgm_idx` (GIN, `gin_trgm_ops`) and
`plate_reads_normalized_exact_idx` were both created by migration `0005`, and they are exactly the
two indexes this design uses.

---

## 8 · Where this fails, stated plainly

- **n is small.** The four `measured` confusions come from three human-legible plates. They are the
  only confusions this estate has been *observed* to make, not the only ones it makes. The matrix is
  config precisely so that a larger labelled set can replace them without a code change.
- **Three-character truncation is recovered only at `d≥2`,** and a fourth missing character is
  outside the tail allowance entirely — `GJ35` will not find `GJ35U0779`, by design. A four-character
  fragment is not an identification.
- **A state code that is misread into another *valid* state code is a hard failure.** `CJ` is not a
  state code, so the anchor is dropped and the plate is still reachable; `GJ` misread as `HJ` would
  be too, since `HJ` is also not an RTO code. But `MH` misread as `MP` is a valid code and the anchor
  will point at the wrong state. `G↔C` is not in the matrix either, because it was not measured.
- **The false-positive rate is measured against a 115-plate corpus.** A real state watchlist is
  hundreds of thousands of rows, and plate space is dense; precision at that scale will be lower than
  100% and this document should be re-measured, not extrapolated, when a real list arrives.
- **`GJ12EC7928 → 50011A` is not recovered and cannot be.** The read shares not one character with
  the truth. No metric closes that gap; better optics do.
- **A candidate is a possibility, not an identification.** Every response carries the disclaimer, the
  weighted distance, and the edit script that produced it, so an operator can see *why* before acting.

---

## 9 · The API

```
GET /api/v1/plates/search
      ?q=GJ01AB1234
      &max_distance=2          # weighted units; 2 is the measured knee (§6)
      &from=2026-09-01T00:00:00Z
      &to=2026-09-05T00:00:00Z
      &camera_ids=<uuid>,<uuid>
      &limit=20
      &sightings_per_candidate=20
```

Authenticated (`READ_ROLES`: admin, supervisor, operator, auditor).

```jsonc
{
  "query": "GJ35U0779",
  "normalized": "GJ35U0779",
  "validity": "valid",            // D2-03 verdict on the *query*
  "reason": null,                 // reasons[0].code, or null
  "missingChars": 0,
  "searched": true,               // false ⇒ the grammar refused; `reason` says why
  "maxDistance": 2,
  "matcher": "confusion-weighted",
  "candidates": [
    {
      "plateNormalized": "GJ35U07",
      "matchType": "fuzzy",       // "exact" | "fuzzy"
      "distance": 0.7,            // weighted, not levenshtein
      "matchStrength": 0.767,     // [0,1]
      "ocrConfidence": 0.61,      // best read of this plate in the window
      "score": 0.468,             // matchStrength × ocrConfidence
      "explanation": "GJ35U07: 2 truncated character(s) — weighted distance 0.70, strength 0.77 (confusion-weighted). A fuzzy candidate, not a confirmed registration.",
      "sightingCount": 1,
      "cameraCount": 1,
      "firstSeen": "2026-05-10T09:05:00.000Z",
      "lastSeen": "2026-05-10T09:05:00.000Z",
      "sightings": [
        {
          "sightingId": "…", "sightingTs": "…", "cameraId": "…",
          "cameraExternalId": "cam07", "cameraName": "…",
          "plateReadId": "…", "rawText": "GJ35U07",
          "ocrConfidence": 0.61, "voteCount": 3, "cropUri": "s3://…"
        }
      ]
    }
  ],
  "disclaimer": "Fuzzy candidates are ranked possibilities, not identifications. …"
}
```

### The watchlist seam

The same metric backs the watchlist lookup through D2-05's `PlateMatcher` interface:

```ts
createWatchlistRegistry({ db, matcher: new ConfusionPlateMatcher(db) });
```

No file in `packages/api/src/watchlist/` changed. `MockProvider` still runs its exact query
independently of the matcher, so an exact hit can never be lost to a candidate generator's threshold
— including this one's refusal to search a `no_letters` string.

---

## 10 · The live estate today

Measured end-to-end through the registry against the seeded watchlist, `max_distance = 2`:

| query (what the pipeline emitted) | before | after |
|---|---|---|
| `GJ35U07` | `GJ35U0779` fuzzy, distance **2.00**, conf 0.78 | `GJ35U0779` fuzzy, distance **0.70**, conf 0.77 |
| `GJ32DD10` | `GJ32D0107` fuzzy, distance **2.00**, conf 0.78 | `GJ32D0107` fuzzy, distance **0.55**, conf 0.82 |
| `GJ3266416`, `AAM412`, `44671`, `1118R`, `46101` | exact | exact |
| `50011A`, `757508300`, `755508000` | nothing | nothing |
| **total** | **5 exact + 2 fuzzy** | **5 exact + 2 fuzzy** |

**The live hit count does not change, and the reason is a correction to a previously published
number.** `docs/watchlist-integration.md` §7 and #19's handoff state that `GJ32D0107 → GJ32DD10` is
edit distance **3** and therefore missed at `max_distance = 2`. It is distance **2**:

```
$ psql -tAc "select levenshtein('GJ32D0107','GJ32DD10');"
2
```

The shipped `TrigramPlateMatcher` already recovered it, so the true baseline was 5 exact + **2**
fuzzy, not 5 + 1. What this ticket changes about that case is not whether it is found but **how
confidently it is ranked** — 0.55 against a budget of 2 rather than 2.00 against a budget of 2, which
is the difference between a candidate an operator can act on and one sitting at the edge of the
threshold. The families in §6 are where the recall change actually lives.

Reproduce the table: `npm run test -w packages/api -- plate-search` (the two
`what the confusion metric adds over plain levenshtein` cases assert exactly this).
