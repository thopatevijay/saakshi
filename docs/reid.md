# Vehicle re-ID bridging (D3-03)

**Held-out precision: 0.761. The bar was 0.9. The feature ships disabled by default.**

That sentence is the headline because it is the finding. SAAKSHI built cross-camera vehicle
appearance re-identification, measured it honestly on a hand-verified set, and turned it off —
`REID_ENABLED` defaults to `false`, and a trace is plate-only unless an officer explicitly asks for
the weaker standard on a deployment that explicitly permits it.

That is the ticket's own instruction rather than a retreat from it. D3-03's AC 3 reads *"measured
precision >= 0.9 **or the feature ships disabled by default**"*, and AC 7 adds *"'We built it,
measured it at 0.NN, and shipped it off by default' is a stronger claim than silence."*

---

## 1 · What the feature is for

In real Indian CCTV most plates are unreadable — angle, night, motion blur, mud, no front plate on a
two-wheeler. On this estate that is not a hypothesis. `fixtures/plate-eval` holds 120 hand-labelled
vehicle instances from the sandbox feeds and **3 of them carry a plate a human can read**
(`docs/anpr-accuracy.md`). A trace built from plate reads alone therefore has holes in it.

Re-ID closes a hole. From one **anchor** — a sighting whose plate *was* read — it attaches a nearby
sighting whose plate was not, when two conditions hold together:

1. the second vehicle could physically have been the first (the spatio-temporal gate), and
2. it looks the same (the appearance comparison).

Never the second alone. Appearance alone links every white hatchback in Gujarat.

## 2 · This is not face recognition

SAAKSHI performs **no face recognition** and stores **no biometric template**. That is a deliberate
scope decision: it is not mandated by the challenge, and it would require separate legal
authorisation.

The word "embedding" appears throughout this document and a reader who assumes it means a face would
be wrong about the most sensitive thing in the system, so it is worth being exact. What
`sighting_appearance.embedding` holds is a description of the *outside of a vehicle*:

- white-balanced colour histograms over four horizontal stripes of the vehicle crop (roof, glass,
  body, wheels), and
- a coarse edge-orientation signature over eight cells.

200 numbers. It cannot identify a person, no person is examined to produce it, and it is derived
from the same best-shot vehicle crop D2-02 already stores as evidence. It expires with its sighting
under D3-05's retention clock. Migration `0022` and `packages/shared/src/evidence.ts` carry the same
statement, because it should be impossible to encounter this feature and not encounter the
distinction.

## 3 · How it works, in the order that matters

```
candidates -> SPATIO-TEMPORAL GATE -> appearance comparison -> link
```

The order is the safety property, not an optimisation.

**Gallery.** Built only from sightings whose plate was actually read — `plate_exact` or
`plate_fuzzy`, never another `reid_bridge` link. An identity bootstrapped from an appearance link
compounds its own error, and at 0.761 precision the second hop would be wrong nearly half the time.

**Candidates.** Best-shot sightings carrying a descriptor, in the trace's window, that no identity
already owns. A best-shot floor of 0.25 applies before anything else: D2-08 opened the shipped crops
and found **Gujarati shop signage** among them — the plate detector fires on high-contrast
rectangular text of any kind, and two such crops match each other happily.

**The gate**, `packages/api/src/services/reid.ts::gateReason`, runs over candidate *metadata only*.
The embedding is not in the type it operates on. Vectors are loaded afterwards, for the survivors
alone, so a candidate that could not have been this vehicle is never compared — the wrong answer is
unreachable rather than merely unlikely. `reid.test.ts` asserts the mechanism: it fails if the
embedding query is ever issued for a gated-out candidate.

| situation | rule | source |
|---|---|---|
| two placed cameras | `timingPlausibility(elapsed, OSRM free-flow) >= 0.25` — about 0.6x to 5.5x of the drive | **D3-01's model**, `services/route.ts`, not a second one |
| unroutable pair | rejected, "travel time unmeasured" | D3-01 calls this `inferred_unroutable` and refuses to score it |
| same camera | a stated **dwell window** of 300 s | a camera cannot be routed to itself; a dwell rule and a travel time are different claims and are kept apart |
| any pair | hard ceiling of 3600 s elapsed | beyond an hour the appearance evidence is doing all the work |

`workers/analytics/reid.py::timing_plausibility` is the same curve in Python so that the offline
measurement runs through the same gate the API applies; `test_reid.py` asserts the two agree.

**The link.** Written to `identity_sightings` as `link_method = 'reid_bridge'` — D2-08's existing
enum value, already violet on the map, already labelled *"the weakest claim here"*, already counted
separately in `coverage.otherLinks` and already carried by the CSV and PDF exports. Nothing new was
invented to carry it.

**The confidence** is deliberately not the raw cosine. Cosines between two normalised histogram
descriptors live in a narrow high band — 0.97 links, 0.93 does not — and writing 0.97 into a column
an officer reads as "97% sure" would be a lie told by a number. The band above the floor is rescaled
onto `[0, 0.6]`; the ceiling keeps a re-ID bridge below every plate match in any sorted list.

## 4 · The embedder, and what it honestly is

D3-03's scope says *"pretrained vehicle re-ID model; no training"*. **No vehicle-re-ID-trained
checkpoint ships here**, and pretending otherwise would be the exact over-claim this project's
claims discipline exists to prevent. `docs/model-licences.md` note 1 is the reason: the only
copyleft stage in the pipeline today is YOLO11, and adding a second one — or a non-commercial
checkpoint — is a procurement decision, not a code change.

So two embedders were built and **both were measured**:

| embedder | what it is | held-out precision | held-out recall |
|---|---|---|---|
| `colour-constant` (**shipped**) | shades-of-grey white balance, then striped HSV histograms + edge signature. No weights, no download, deterministic, ~0.4 ms/crop | **0.761** | 0.593 |
| `yolo` | the YOLO11n backbone already in the pipeline, penultimate 256-d features | 0.714 | 0.339 |

The pretrained network is **worse on both axes**, and that is a finding rather than an
embarrassment: a detection backbone is trained to make all cars look alike so that it can call them
cars, which is the opposite of the invariance re-ID needs. Dropping that arm from this document
would have been a claim by omission.

`OnnxEmbedder` is the seam for a permissively-licensed vehicle-re-ID checkpoint when one is chosen —
`SAAKSHI_REID_WEIGHTS`, one entry in `docs/model-licences.md`, and a re-run of the calibration.

## 5 · The measurement

```bash
python -m workers.analytics.reid_dataset build     # rebuild the labelled pairs
python -m workers.analytics.eval_reid --fixtures fixtures/reid-eval
```

Committed output: `docs/reid-measurement.json`. A test asserts the shipped threshold matches it, so
a threshold change that is not re-measured fails the suite instead of quietly shipping.

### The labelled set — 59 positive, 51 negative

`fixtures/reid-eval/pairs.json`, built from the already-hand-labelled `fixtures/plate-eval`
instances. No pair is proposed by the thing being measured; every label is a physical fact about the
footage or a human's verdict on a contact sheet.

| stratum | n | label | why the label is true |
|---|---|---|---|
| `same_camera_pass` | 59 | same | two crops of one ByteTrack pass, **every one opened and confirmed by eye** |
| `same_camera_simultaneous` | 42 | different | two instances whose passes overlap in frame index on one camera — both on screen at the same instant, so one vehicle cannot be both |
| `tracker_id_switch` | 9 | different | a pass the tracker held as one id that a human found to contain two vehicles |
| `cross_camera_diagnostic` | 300 | different | inferred, not observed — **reported separately, never in the headline** |
| (excluded) | 7 | unusable | a human could not adjudicate; plate-eval's labelling rule 2 applies verbatim |

### The finding inside the fixture: 21% of tracker passes do not hold one vehicle

Of 75 candidate positives, **16 failed eye verification** — 9 outright ByteTrack identity switches
(an auto-rickshaw becoming a hatchback, a bus becoming a white car) and 7 pairs no human can
adjudicate, two of which are **not vehicles at all** but roadside lettering. That is the same
high-contrast-text failure D2-08 found in the shipped plate crops, showing up again in a different
place.

Had those 16 stayed in, the switches would have been counted as *correct* links whenever the matcher
joined them — precision manufactured out of a labelling bug. `EYE_VERDICTS` in
`workers/analytics/reid_dataset.py` records every verdict with its reason.

### Calibration: leave-one-camera-out

The threshold is fitted on five cameras and applied to the sixth, six times, and the pooled result
is what is reported. Grouped by camera rather than at random, because a random split would put one
camera's illumination on both sides and the threshold would be fitted on the very nuisance variable
it has to generalise across.

The fitting rule was fixed before any number was seen: *the lowest threshold whose precision on the
fitting fold reaches 0.9* — lowest, because among thresholds that clear the floor the lowest keeps
the most recall. **No threshold was moved after seeing its precision.**

| | threshold | TP | FP | FN | precision | recall |
|---|---|---|---|---|---|---|
| fitted on everything (**not** the measurement) | 0.9330 | 38 | 4 | 21 | 0.905 | 0.644 |
| **held out, pooled (the measurement)** | per fold | 35 | **11** | 24 | **0.761** | 0.593 |

Per fold:

| held-out camera | threshold | TP | FP | FN | precision | recall |
|---|---|---|---|---|---|---|
| cam04 | 0.9385 | 4 | 0 | 3 | 1.000 | 0.571 |
| cam06 | 0.9385 | 3 | 0 | 0 | 1.000 | 1.000 |
| cam07 | 0.9385 | 3 | 0 | 3 | 1.000 | 0.500 |
| cam10 | 0.9310 | 3 | 2 | 6 | 0.600 | 0.333 |
| cam21 | 0.8935 | 6 | 9 | 3 | **0.400** | 0.667 |
| cam30 | 0.9630 | 16 | 0 | 9 | 1.000 | 0.640 |

The gap between 0.905 fitted and 0.761 held out **is the whole story**: the threshold does not
transfer between cameras. cam21's fold fitted 0.8935 on the other five and scored 0.400 on cam21.
A single global threshold is the wrong shape for this estate, and reporting the fitted 0.905 as
though it were a measurement would have hidden that.

By condition, at the shipped threshold: **night 1.000 precision / 0.870 recall**, **day 0.818 /
0.500**. Counter-intuitive, and explicable — at night a vehicle is mostly its own lit surfaces
against a dark background, which is a *more* separable signal than a daylit vehicle against a busy
street.

## 6 · Where it fails, and the colour-constancy problem

**Colour constancy across cameras is the central difficulty, and it is mitigated, not solved.** The
estate spans six distinct resolutions and a measured luma range of 8.40 to 135.19 (D1-05). The same
white car is a materially different colour on two cameras. Every embedder therefore runs
shades-of-grey white balance (Finlayson & Trezzi 2004, Minkowski p=6) before it looks at colour, and
`test_reid.py` asserts the correction narrows the gap between two illuminants without disturbing an
already-neutral image.

What is left over is visible in the diagnostic stratum, and it is not good news:

| set | mean similarity | max |
|---|---|---|
| same vehicle, same camera | 0.942 | — (min 0.782) |
| different vehicles, same camera | 0.831 | 0.963 |
| different vehicles, **different cameras** | **0.679** | 0.902 |

**0 of 300 cross-camera pairs cleared the threshold.** Read carelessly that looks like a perfect
cross-camera false-link rate. It is the opposite: the cross-camera distribution sits *far below* the
same-camera negatives, which means the descriptor is separating **cameras** rather than **vehicles**.
Two crops from different cameras look different to it *because they are from different cameras*. The
implication is direct: **cross-camera recall would be close to zero**, and cross-camera is what
re-ID is for.

**No cross-camera positive pair exists to test that with.** On this estate none can be labelled — 3
legible plates in 120 instances means no plate anchor tying one vehicle to two cameras, and no two
sandbox cameras share a view. So cross-camera performance is reported as **unmeasured**, never as a
number. `fixtures/reid-eval/pairs.json` carries that statement as a field, and a test asserts no
cross-camera positive has crept in.

Three more limits worth stating plainly:

- **The descriptor dilutes its own colour evidence.** Cosine over sqrt-normalised histogram blocks
  is a weighted mean of per-block Bhattacharyya coefficients. On a flat crop, saturation, value and
  shape blocks agree between two vehicles and only hue disagrees, so a red car and a blue car land
  at ~0.97 — above the floor. Real crops carry texture and background, which is why measured
  same-camera negatives average 0.83, but the dilution is the mechanism behind the 4 false links in
  the fitted set. A successor descriptor should take a per-block minimum, or learn the metric.
  `test_reid.py::test_reid_embedding_dilutes_its_own_colour_evidence` pins it.
- **The gate weakens as the gallery grows.** A candidate needs to be reachable from only *one*
  anchor. With two anchors twenty minutes apart and a ten-minute drive between cameras, almost any
  placed candidate in the window is reachable from one of them. The gate is a coarse filter, and on
  this estate its strongest single contribution is rejecting the **unplaced** cameras — which is all
  thirty of the real ones.
- **Two-wheelers, oblique angles and small crops** are where the positives fail. The measured
  minimum same-vehicle similarity is 0.782, well under the floor: those 24 held-out false negatives
  are mostly motorcycles and 40-pixel crops.

## 7 · What ships, and how to turn it on

Disabled by default in three independent places, each of which is enough on its own:

1. `REID_ENABLED` is not `true` — the bridge refuses to run and the trace ignores stored appearance
   links entirely (not merely hides them from a count);
2. `include_reid` on `GET /api/v1/trace` defaults to `false`;
3. the trace screen's **include re-ID** checkbox is unticked, and the URL carries the choice so a
   shared trace link carries the evidentiary standard it was run under.

With it off, a trace is plate-only and every acceptance criterion of D2-08 behaves exactly as it did.
The response always reports `reid: { requested, enabled, links, measuredPrecision, disclaimer }`, so
a client can render "asked for, not available" rather than a silent plate-only result under a switch
that looks on. The UI prints the measured precision beside any appearance link it shows.

```bash
REID_ENABLED=true npm run reid:bridge -w @saakshi/api -- \
  --plate GJ01AB1234 --purpose "FIR 123/2026" --dry-run
```

A bridge writes evidence rows and appends to the tamper-evident audit chain as `reid.bridge`, so
`--purpose` is mandatory exactly as it is on the endpoint (D3-04). A `GET` never writes links.

## 8 · Measured trace completeness, with and without

`packages/api/src/services/trace-reid.test.ts` runs the scenario end to end against the real
database: two plate-read anchors on one camera, one sighting on a second camera **with no plate read
at all**, and one perfect-appearance decoy on an unplaced camera.

| | sightings | cameras | link methods |
|---|---|---|---|
| re-ID off (default) | 2 | 1 | 2 exact |
| re-ID on | **3** | **2** | 2 exact + 1 appearance |

**+1 sighting, +1 camera, on a trace that would otherwise have shown a vehicle at a single location.**
That is the shape of the benefit: it is not marginal when it fires. It is also, at 0.761 precision,
wrong about one time in four — which is why the officer, not the system, decides whether to accept
it. The decoy on the unplaced camera is rejected by the gate despite an identical embedding, which
is the property the gate exists to provide.

## 9 · Roadmap

The capability is built, wired end to end and measured. What would make it shippable-on:

1. **A vehicle-re-ID-trained checkpoint** under a permissive licence, through `OnnxEmbedder`. This
   is the single biggest lever — a metric learned for identity rather than for detection.
2. **Per-camera-pair thresholds** instead of one global one. The leave-one-camera-out spread (0.400
   to 1.000) says a global threshold is the wrong shape.
3. **A cross-camera labelled set**, which needs either overlapping camera views or a period of
   footage with readable plates on two cameras. Without it, cross-camera performance stays
   unmeasured however good the model becomes.
4. **Colour calibration per camera** from a stable reference surface in each view, rather than a
   per-crop grey-world assumption.

Until at least (1) and (3), the honest position is the one shipped: built, measured at 0.761,
off by default.
