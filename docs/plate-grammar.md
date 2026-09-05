# Indian registration-plate grammar — the format we implement

D2-03. Implementation: `packages/shared/src/plate/{normalise,grammar}.ts`. Table:
`fixtures/plate-grammar-cases.json`. Tests: `packages/shared/src/plate/plate.test.ts`.

Pure, deterministic, zero I/O, no model. Cheap logic that materially raises match quality — and, on
this estate, the component that keeps advertising hoardings out of the watchlist.

---

## 1 · Why this module is load-bearing, in numbers

D2-01 measured ANPR against the Sentinel sandbox estate on a 120-instance hand-labelled sample
(`docs/anpr-accuracy.md`). Two findings define this ticket.

**The highest-confidence plate read of the entire 5-minute, 8-camera live run was `757508300` at
0.888 — the phone number on a roadside advertising hoarding on `cam05`.** 15 of the 120 labelled
instances are signage: shop fronts, a road sign reading `CIRCLE`, an illuminated hoarding, lettering
on a truck body. Every one is a rectangular light-on-dark text region, which is exactly what a plate
detector is trained to find. Nothing downstream of the OCR can tell a hoarding from a plate. This
grammar can.

**Reads are truncated, not garbled.** For the three human-legible plates in the labelled set:

| ground truth | pipeline read | this validator |
|---|---|---|
| `GJ35U0779` | `GJ35U07` | **partial** · standard · state `GJ`, RTO `35`, series `U`, 2 chars short |
| `GJ32D0107` | `GJ32DD10` | **partial** · standard · 2 chars short |
| `GJ12EC7928` | `50011A` | **invalid** · `no_state_code` |

A validator that demands a complete 9–10 character registration returns "invalid" for all three —
technically correct and operationally useless. So **`partial` is a first-class result**, carrying
`missingChars` and the parsed parts, and every rejection carries a typed reason code that D2-04
weights its fuzzy search on and D3-06 reports per camera.

---

## 2 · Normalisation — the canonical stored form

```ts
normalise(' ind gj-01 ab 1234 ')  // 'GJ01AB1234'
```

1. Uppercase.
2. Drop every character outside `A-Z0-9` — spaces, hyphens, dots, Devanagari and Gujarati glyphs
   from the state name printed above the number, control characters, anything the OCR hallucinated.
3. Strip a leading `IND` repeatedly. Indian plates carry the `IND` country mark beside the national
   emblem on the left, and plate crops routinely include it. No RTO state code begins with `IN`, so
   this cannot eat a registration. Stripping in a loop is what keeps the function idempotent.

**Total** — every input returns a string, including `null`, `undefined`, numbers and objects
arriving from untyped JSON at a queue boundary. Nothing throws.
**Idempotent** — `normalise(normalise(x)) === normalise(x)` for all `x`.

> **This output character set is a contract, not an implementation detail.**
> `watchlist_entries.plate_normalized` and every watchlist lookup are keyed on it (D2-05, #19; 235
> seeded rows), and D2-04's fuzzy index keys on `plate_reads.normalized_text`, which is the same
> form. Changing the set breaks matching *silently*: the row is still there, the equality just never
> holds. It is `[A-Z0-9]` and it stays `[A-Z0-9]`.

Normalisation performs **no** validation: `normalise('CIRCLE') === 'CIRCLE'`. Keeping the two
separate is what lets an ungrammatical read still be stored and flagged rather than discarded.

---

## 3 · The grammar

Five families. Variable-length families are expanded into concrete fixed-length layouts rather than
matched with a regex, because the corrector needs to know which slot each individual character sits
in, and because "is this a truncated prefix?" then becomes a subtraction rather than a parse.

| format | shape | example | length |
|---|---|---|---|
| `standard` | `<state:2 alpha><rto:1–2 digit><series:1–3 alpha><number:4 digit>` | `GJ01AB1234` | 8–11 |
| `bharat_series` | `<yy:2 digit>BH<number:4 digit><series:1–2 alpha>` | `22BH1234AA` | 9–10 |
| `military` | `<year:2 digit><class:1 alpha><serial:6 digit><check:1 alpha>` | `06B123456A` | 10 |
| `diplomatic` | `<mission:2–3 digit><CD\|CC\|UN><serial:3–4 digit>` | `33CD0001` | 7–9 |
| `legacy_no_series` | `<state:2 alpha><rto:1–2 digit><number:4 digit>` | `GJ011234` | 7–8 |

Notes on the edges:

- **Delhi's letter-suffixed RTO** (`DL 1C AA 1234`) needs no special case: it falls out of the
  1-digit RTO plus 3-letter series combination as `DL|1|CAA|1234`.
- **`legacy_no_series` is last in preference order.** It is the only family with no alphabetic
  series, so it must never win against a standard reading that fits without correction.
- **A literal marker (`BH`, `CD`, `CC`, `UN`) is never corrected *into*.** Without that rule any four
  characters become a Bharat-series plate and the families stop discriminating anything.
- **`BH` is not a state code.** It is a marker in the middle of a different layout, so `BH01AB1234`
  is rejected as `unknown_state_code`.

### Sources

- Rule 50 and Rule 51 of the Central Motor Vehicles Rules, 1989 — plate dimensions, character
  layout, and the `IND` country mark.
- MoRTH notification G.S.R. 594(E), 26 August 2021 — the Bharat (BH) series and its
  `YY BH #### XX` form.
- The RTO state/UT code allocation published by MoRTH and by each state transport department —
  the table in §4.
- Empirically: D2-01's error analysis (`docs/anpr-accuracy.md`) and D2-05's watchlist seed
  (`fixtures/watchlist-seed.csv`), which is where the confusion set and the non-plate cases come
  from.

---

## 4 · State codes — the list to edit

`STATE_CODES` in `packages/shared/src/plate/grammar.ts` is a flat `code -> region` record, one entry
per line. **Adding a code is a single line there and nothing else**: the layouts, the validator, the
corrector and the fixtures all read from it, and a test asserts no individual code is hardcoded
anywhere else in the module.

Retired codes are kept alongside their replacements, because a 2004 plate is still a plate:
`OR`/`OD`, `UA`/`UK`, `TS`/`TG`, `DN`/`DD`.

| code | region | code | region |
|---|---|---|---|
| `AN` | Andaman and Nicobar Islands | `MN` | Manipur |
| `AP` | Andhra Pradesh | `MP` | Madhya Pradesh |
| `AR` | Arunachal Pradesh | `MZ` | Mizoram |
| `AS` | Assam | `NL` | Nagaland |
| `BR` | Bihar | `OD` | Odisha |
| `CG` | Chhattisgarh | `OR` | Odisha (legacy) |
| `CH` | Chandigarh | `PB` | Punjab |
| `DD` | Dadra and Nagar Haveli and Daman and Diu | `PY` | Puducherry |
| `DL` | Delhi | `RJ` | Rajasthan |
| `DN` | Dadra and Nagar Haveli (legacy) | `SK` | Sikkim |
| `GA` | Goa | `TN` | Tamil Nadu |
| `GJ` | Gujarat | `TR` | Tripura |
| `HP` | Himachal Pradesh | `TS` | Telangana |
| `HR` | Haryana | `TG` | Telangana (2024 onward) |
| `JH` | Jharkhand | `UA` | Uttarakhand (legacy) |
| `JK` | Jammu and Kashmir | `UK` | Uttarakhand |
| `KA` | Karnataka | `UP` | Uttar Pradesh |
| `KL` | Kerala | `WB` | West Bengal |
| `LA` | Ladakh | | |
| `LD` | Lakshadweep | | |
| `MH` | Maharashtra | | |
| `ML` | Meghalaya | | |

---

## 5 · Slot-aware correction — and why it is deliberately asymmetric

A character sitting in a slot whose character class it cannot possibly belong to is a
**structurally impossible** read, and the confusable character of the right class is the best
available repair. `GJO1AB1234 -> GJ01AB1234`, with `{ index: 2, from: 'O', to: '0', slot: 'rto' }`
recorded on the result.

### The two directions are not equally safe

**Letter → digit, in a numeric slot: always allowed.** A letter where only digits are legal is
definitely wrong. D2-05 measured `0 -> D` on live output; correcting `D` back to `0` in a numeric
slot is exactly this direction.

| from | to | also confusable with |
|---|---|---|
| `O` `D` `Q` | `0` | |
| `I` `L` | `1` | |
| `Z` | `2` | |
| `A` | `4` | |
| `S` | `5` | |
| `G` | `6` | `9` |
| `T` | `7` | |
| `B` | `8` | `6` |

**Digit → letter: allowed only inside the `series` slot, and only when that slot already contains at
least one real letter.** This guard is the whole ballgame:

- Without it, `757508300` fits `standard` as **`TS75O8300`** — `7 -> T`, `5 -> S` in the state slot,
  `0 -> O` in the series — a structurally perfect Telangana registration. The cam05 hoarding becomes
  a watchlist hit at the highest confidence in the run.
- Without it, `GJ3266416` — one of the five non-plates D2-05 seeded *because the pipeline emits
  them* — launders into `GJ32G6416`.

So: **the state-code slot is never corrected at all**, and a digit is only read as a letter where an
adjacent letter has already established that the slot is alphabetic (`GJ01A81234 -> GJ01AB1234`,
because `A` anchors the series). The state code is additionally checked against the enumeration in
§4, not merely against `[A-Z]{2}` — without that, `ZZ01AB1234` fits perfectly.

The confusable characters the corrector did *not* apply are recorded on each correction as
`alternatives`, so D2-04 can branch on them instead of re-deriving them.

**At most 2 corrections** (`MAX_CORRECTIONS`). Above that it is a guess, not a repair.

### Choosing between candidate readings

Fewest corrections wins, then fewest missing characters, then layout declaration order. If two
equally-cheap readings disagree about the corrected string, the result is `invalid` with reason
`ambiguous` — the validator refuses to pick.

**Fewest corrections beats completeness, and this is a deliberate bias toward not inventing
characters.** `GJ32DD10` fits `legacy_no_series` *completely* as `GJ320010` with two corrections, and
fits `standard` as an uncorrected prefix two characters short. The prefix is chosen.

**Where that costs us, honestly:** ground truth for that read is `GJ32D0107`. The rejected
1-correction reading (`GJ32D|010`, one character short) is a true prefix of the real plate; the
0-correction reading we chose, `GJ32DD10`, is not. On this single case the conservative rule loses.
It is kept anyway, because n = 1 is not enough to tune on and because a corrector that prefers to
rewrite characters over admitting truncation is the failure mode that produces confident wrong
identifications. D2-04 sees `missingChars` and the confusion alternatives and can search both.

---

## 6 · The confidence rule

```
adjusted = raw × VALIDITY_FACTOR[validity]
               × CORRECTION_FACTOR ^ (number of corrections)
               × (NON_PLATE_FACTOR if the read has no letters at all, or no digits at all)
```

| constant | value | why |
|---|---|---|
| `VALIDITY_FACTOR.valid` | `1.00` | a complete registration under some layout |
| `VALIDITY_FACTOR.partial` | `0.75` | a clean prefix — a real identification, but incomplete |
| `VALIDITY_FACTOR.invalid` | `0.40` | failed the grammar; retained, flagged, down-weighted |
| `CORRECTION_FACTOR` | `0.90` | per correction, compounding |
| `NON_PLATE_FACTOR` | `0.25` | *cannot possibly be a registration* — signage, a phone number, a price |

Deliberately a flat product of independent, auditable factors rather than a tuned score, because a
single opaque number cannot be argued with in front of a jury. Two properties follow:

- `adjusted ≤ raw` always, and `adjusted == raw` only for a clean, complete, uncorrected read.
- `NON_PLATE_FACTOR` separates *"failed the grammar"* from *"is not a plate"*. The cam05 hoarding at
  **0.888 lands at 0.0888** — bottom of the entire live run, from the top of it.

Positional detail (`completeness`, `missingChars`, `reasons`, `parts`) is exposed as **data** rather
than folded into the number, because D2-04 ranks on it.

---

## 7 · Rejection reasons — a D2-04 interface

"Invalid" alone tells a fuzzy matcher nothing. Every rejection carries a typed code:

| code | means | what D2-04 should do with it |
|---|---|---|
| `truncated` | clean prefix, `missingChars` short | search prefixes; do **not** penalise the missing tail as substitutions |
| `unknown_state_code` | two letters, not an RTO code | weight positions 0–1 heavily; `C→F`, `E→F` live here |
| `no_state_code` | positions 0–1 are not two letters | the read is not anchored; low prior |
| `bad_series` | series region is not alphabetic and cannot be repaired | possible digit/letter confusion at a known index |
| `bad_number` | trailing number is the wrong length or class | truncation or a trailing substitution |
| `missing_rto_digits` | no digits after the state code | |
| `no_letters` | all digits | **do not search** — signage, a phone number, a price |
| `no_digits` | all letters | **do not search** — a shop fascia or a road sign (`CIRCLE`) |
| `too_short` | under 4 characters | |
| `too_long` | longer than any layout | |
| `ambiguous` | two readings disagree | search both candidates |
| `empty` | nothing survived normalisation | |
| `non_plate_shape` | unlike any registration | |

---

## 8 · What it does to what the pipeline actually emitted

Every plate read of D2-01's live run, with its OCR confidence, put through `evaluatePlateRead`:

| read | raw conf | verdict | adjusted | primary reason |
|---|---|---|---|---|
| `757508300` | 0.888 | invalid | **0.0888** | `no_letters` — the cam05 hoarding |
| `44671` | 0.732 | invalid | 0.0732 | `no_letters` |
| `P41` | 0.687 | invalid | 0.2748 | `too_short` |
| `1118R` | 0.627 | invalid | 0.2508 | `no_state_code` |
| `41111` | 0.584 | invalid | 0.0584 | `no_letters` |
| `755508000` | 0.575 | invalid | 0.0575 | `no_letters` — the same hoarding |
| `46101` | 0.560 | invalid | 0.0560 | `no_letters` |
| `46111` | 0.514 | invalid | 0.0514 | `no_letters` |
| `AAM412` | 0.503 | invalid | 0.2012 | `unknown_state_code` |
| `GJ3266416` | 0.449 | invalid | 0.1796 | `bad_series` |
| `15144` | 0.429 | invalid | 0.0429 | `no_letters` |
| `41111` | 0.360 | invalid | 0.0360 | `no_letters` |
| `71TT` | 0.355 | invalid | 0.1420 | `no_state_code` |
| `7` | 0.336 | invalid | 0.0336 | `too_short`, `no_letters` |
| `A1110` | 0.323 | invalid | 0.1292 | `no_state_code` |

**0 valid, 0 partial, 15 rejected — and that is the correct answer.** None of these fifteen strings
is a vehicle registration. Two of them are the same hoarding's phone number, five are the non-plates
D2-05 seeded, and the rest are fragments. The single most useful thing this module does on the live
estate is return nothing.

On the labelled set, where legible plates do exist, it returns something: 2 of the 3 legible plates
survive as `partial` identifications with the state, RTO and series intact (§1). That is the honest
shape of this estate — see `docs/anpr-accuracy.md` for why there are only three.

**No accuracy claim is made here.** These are the outputs of a deterministic grammar on a recorded
set of strings, reproducible with `npm run test -w packages/shared -- plate`.
