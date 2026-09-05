# ANPR accuracy — measured, on this estate

ANPR is the challenge's **only mandatory analytic**, so it is the number a judge is most entitled to
check. This document records what was measured, on what, and where it fails. Nothing here is
aspirational, and the headline is not flattering.

> **The one-line answer.** On a 120-instance hand-labelled sample from the Sentinel sandbox, the
> pipeline read **0 plates exactly right**, because the estate presented **3 plates a human could
> read** in the first place. Against the challenge's stated *>90% detection/processing accuracy*
> target, this **misses, by every metric, in both day and night conditions.** The cause is measured
> below and it is the camera estate, not the models — but the number is the number.

Measured 2026-09-05 · commit on `feat/d2-01-anpr-pipeline-05-09-2026` · reproducible with the
commands in every section.

---

## 1 · Why the number is what it is: this estate has almost no plates in it

Before any accuracy question, a prior one: **is a plate present in the image at all?**

| measurement | result |
|---|---|
| D0-01 recon frames (30 cameras x 4 offsets = 120 frames) with **any** plate detection | **10 of 120** |
| largest plate in those 120 frames | **74 x 37 px** |
| day sample: vehicle passes mined from 1,064 frames across 6 cameras | 1,813 |
| …of those, with a plate box above the 20 px floor | **187 (10.3%)** |
| night sample: vehicle passes mined from 1,012 frames | 825 |
| …of those, with a plate box | **45 (5.5%)** |
| hand-labelled instances where a **human** could read the plate | **3 of 120 (2.5%)** |

The 30 cameras of the sandbox estate are **wide-area PTZ junction overviews**, not RLVD or ANPR
lane cameras. A plate on them is typically 20–50 px wide — between two and five pixels per
character. The single largest plate found anywhere in the day sample was **111 px** and it was
motion-blurred beyond reading.

This is the finding, and it is a *product* finding rather than a defect: **the estate as deployed
cannot support plate recognition at the accuracy the challenge asks for, on most of its cameras.**
Pillar 1's trust score already surfaces which cameras are useless for which analytic; this is the
ANPR column of that argument, with numbers behind it.

---

## 2 · The evaluation set

`fixtures/plate-eval/` — 120 hand-labelled instances, committed with the crops that were labelled.
Full method in `fixtures/plate-eval/README.md`; the two decisions that matter:

**The sampling unit is a vehicle box from D1-09's YOLO11 detector, which knows nothing about
plates.** Ground truth cannot come from the thing being measured: a set built from plate-detector
proposals can only measure precision, because every plate the detector missed would be missing from
the ground truth too and recall would be 1.0 by construction.

**Two strata, reported separately and never averaged:**

| stratum | what it is | what it answers |
|---|---|---|
| `representative` (40) | uniform random sample of vehicle instances above the pipeline's size floor, seeded | what does this estate yield? |
| `enriched` (80) | the largest plate-bearing instances available | when a readable plate *is* presented, is it read? |

Cameras: `cam04`, `cam06`, `cam07`, `cam10`, `cam21`, `cam30` — chosen as the six highest
plate-yield cameras in the D0-01 recon survey. **The set is therefore the estate's best case, not
its average**, which makes the low numbers below conservative in our own favour rather than
pessimistic.

Day and night are separated by the **burnt-in timestamp**, not by the seek offset: each camera's
recording starts at its own wall time, so offset 39600 s lands at 08:00 on `cam30` and at 13:24 on
`cam21`. Day frames are daylight and night frames are 03:00–04:00, verified frame by frame.

---

## 3 · Measured precision and recall

```bash
python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval --compare
```

Backend `fast_plate_ocr` (the shipped default), plate model `yolo-v9-s-608-license-plate-end2end`,
best-shot strategy.

| slice | instances | human-legible | plate-detection recall | read recall (exact) | precision | character accuracy |
|---|---|---|---|---|---|---|
| **combined** | 120 | 3 | **100.0%** | **0.0%** | **0.0%** | **51.8%** |
| day | 75 | 1 | 100.0% | 0.0% | 0.0% | 0.0% |
| night | 45 | 2 | 100.0% | 0.0% | 0.0% | 77.8% |
| enriched | 80 | 3 | 100.0% | 0.0% | 0.0% | 51.8% |
| representative | 40 | 0 | n/a | n/a | 0.0% | n/a |

Per camera:

| camera | instances | legible | reads emitted | correct |
|---|---|---|---|---|
| cam04 | 24 | 0 | 4 | 0 |
| cam06 | 5 | 0 | 2 | 0 |
| cam07 | 22 | 2 | 14 | 0 |
| cam10 | 15 | 0 | 3 | 0 |
| cam21 | 25 | 0 | 19 | 0 |
| cam30 | 29 | 1 | 9 | 0 |

**Definitions, because "accuracy" is doing a lot of work in the challenge's target:**

- **plate-detection recall** — plate boxes above the width floor, over human-legible plates. **100%:
  the plate detector found every plate a human could read.** The detection half of the pipeline is
  not the problem.
- **read recall** — reads that exactly equal the human label, over human-legible plates. `0/3`.
- **precision** — correct reads over *all* reads emitted, including the 48 emitted on instances no
  human could read. Those are false positives whatever they say.
- **character accuracy** — `1 - editDistance/len(label)`, averaged over legible instances that
  produced a read. Reported because a one-character miss and a total miss are different failures,
  and D2-04's fuzzy matching survives the first.

### The three legible plates, in full

| instance | camera | plate px | ground truth | pipeline read | char acc | confidence |
|---|---|---|---|---|---|---|
| `day_cam30_042_00` | cam30 | 76 | `GJ12EC7928` | `50011A` | **0.0%** | 0.373 |
| `night_cam07_111_02` | cam07 | 56 | `GJ32D0107` | `GJ32DD10` | 77.8% | 0.584 |
| `night_cam07_102_02` | cam07 | 52 | `GJ35U0779` | `GJ35U07` | **77.8%** | 0.764 |

The bottom two rows are the shape of what is achievable here: the **state and district codes are
right and the trailing digits are dropped or confused**. `GJ35U07` against `GJ35U0779` is exactly
the case D2-04's confusion-aware fuzzy matching exists to recover, and it is why character accuracy
is reported alongside exact-match rather than instead of it.

The top row is the other shape: a 76 px daylight plate on a dark car read as `50011A`, sharing not
one character with the truth. **Being the largest plate does not make it the easiest** — that one is
low-contrast dark-on-dark, while the two night plates are retro-reflective under a streetlight.

**n = 3.** Every rate in the "legible" column is computed over three plates. They are reported as
counts as well as percentages throughout, and no rate derived from them should be quoted as an
accuracy figure for a deployment.

### Precision as the confidence floor rises

| floor | reads | correct | precision |
|---|---|---|---|
| 0.00 | 51 | 0 | 0.0% |
| 0.40 | 35 | 0 | 0.0% |
| 0.50 | 22 | 0 | 0.0% |
| 0.60 | 10 | 0 | 0.0% |
| 0.70 | 4 | 0 | 0.0% |
| 0.80 | 1 | 0 | 0.0% |
| 0.90 | 0 | 0 | n/a |

Raising `SAAKSHI_OCR_CONF_MIN` to 0.8 removes 50 of 51 reads. On this estate the confidence floor is
a way to make the system *say less*, not a way to make it say the right thing. It is left at the
documented 0.30 so that the eval measures what the pipeline does rather than what a floor hides,
and D2-04 sets it from data.

---

## 4 · Against the challenge's stated >90% target

`PROJECT.md` records the challenge's *"detection / processing accuracy > 90%"*. Reported honestly:

| condition | metric | measured | verdict |
|---|---|---|---|
| day | read recall | 0.0% | **MISSES** |
| day | precision | 0.0% | **MISSES** |
| night | read recall | 0.0% | **MISSES** |
| night | precision | 0.0% | **MISSES** |
| combined | read recall | 0.0% | **MISSES** |
| combined | precision | 0.0% | **MISSES** |
| combined | **plate-detection recall** | **100.0%** | meets, on n=3 |

The eval CLI prints this table itself, so the verdict cannot drift from the code.

**What would have to change for the target to be reachable**, in order of leverage:

1. **Camera placement and zoom.** A plate needs roughly 100–150 px of width for reliable OCR; this
   estate delivers 20–50. This is a procurement and PTZ-preset question, not a model question, and
   it is the single change that would move the number.
2. **Dedicated ANPR/RLVD cameras at the junctions that matter.** `cam07` at night — a closer,
   streetlit view — is the only camera in the sample that produced plates a human could read at all,
   and it produced two of the three.
3. Model fine-tuning on Indian plates would help the last few percent. It is not the bottleneck and
   claiming it as one would be misdirection.

---

## 5 · Best-shot selection versus every-frame OCR

The ticket's claim: best-shot gives *equal-or-better accuracy at materially lower inference count*.
Both halves were tested. **One held and one did not.**

### On the estate set (`--compare`)

| strategy | OCR inferences | exact reads | character accuracy | wall |
|---|---|---|---|---|
| best-shot | **153** | 0 | 51.8% | 23.6 s |
| every-frame | 222 | 0 | 51.8% | 25.1 s |

Best-shot ran **69 fewer OCR inferences — 68.9% of the every-frame count** for **identical**
character accuracy. On the one instance where the two strategies had a real choice
(`day_cam30_042_00`, a 7-frame pass) best-shot read three frames and every-frame read seven, and
they arrived at the same wrong answer.

### On synthetic vehicle passes with known ground truth

`pytest workers/analytics/anpr -q -k strategy`. Eight registrations, each rendered as an 8-frame
pass: two good frames (close, square-on) and six degraded the way a real pass degrades (oblique,
motion-blurred, receding).

```
best-shot   8/8 exact, 24 OCR inferences
every-frame 8/8 exact, 64 OCR inferences
```

**Equal accuracy at 37.5% of the inference count.** The cost claim is proven twice — 37.5% here and
68.9% on the estate set. The *accuracy* claim — that best-shot is better, not merely cheaper —
**was not reproduced on either set**. The mechanism is measurably real (the score's mean separation
between good and degraded frames is asserted in `test_strategy.py`), but on these fixtures the extra
frames every-frame reads do not outvote the good ones often enough to cost it a plate.

So the honest statement is: **best-shot gives the same answer for a fraction of the compute**, which
is reason enough to ship it. It is not, on anything measured here, more accurate. The ticket asserts
both; only one held.

---

## 6 · Where it fails, specifically

Drawn from the `note` field of all 120 labelled instances — the failure taxonomy is data, not
recollection.

| failure | instances | what it looks like |
|---|---|---|
| **too few pixels per glyph** | dominant | 20–50 px plates on wide-area PTZ views. The plate is *there*, the glyphs are not. |
| **blown highlight (night retroreflection)** | 7 of 30 night enriched | `cam30` at night: headlights and IR retroreflect off the plate and saturate it to flat white. An 84 px plate with **no glyph structure at all** — bigger and less readable than a 40 px daytime plate. |
| **motion blur** | frequent on `cam30`, `cam21` | The largest plate in the whole day sample (111 px) is unreadable for this reason alone. |
| **oblique / grazing angle** | frequent on `cam07`, `cam21` | Plates nearly edge-on to a junction camera. Rectification helps (§7) but cannot recover glyphs the sensor never resolved. |
| **plate-detector false positives** | 15 of 120 | Shop signage (Gujarati and English), a road sign reading `CIRCLE`, an illuminated hoarding, truck body lettering, headlight bloom. **Every one is a rectangular light-on-dark text region**, which is what the model was trained to find. |
| **two-wheelers** | most motorcycle instances | Two-row plates, small, usually occluded by the rider's leg or a pillion. Not one motorcycle in the sample produced a readable plate. `frontality` deliberately does *not* filter the 1.43:1 two-row aspect, so they enter the pipeline and are counted as failures rather than being silently dropped. |

**Night is not uniformly worse than day here, and that is worth saying.** Night character accuracy
(77.8%) is *higher* than day (50.0%) in this sample, because the only camera with a close,
well-lit view happens to be `cam07` at night. Meanwhile `cam30` at night is the worst case in the
whole set — retroreflection destroys plates that daylight merely blurs. **"Night is worse" is too
coarse a claim for this estate; the variance is per camera, not per condition.**

---

## 7 · Two engineering findings worth carrying forward

### The OCR backend must choose its own resampling, or one of them reads nothing

A 40 px plate warped to the canonical 192x48 is a ~4x magnification. Cubic interpolation there does
not recover detail that was never sampled; it smooths each glyph edge across four output pixels.

| rectified with | `fast_plate_ocr` | `paddle_ppocr` |
|---|---|---|
| `INTER_CUBIC` | `RJ3CA518` · `GJ11EH2` | **nothing on either** |
| `INTER_NEAREST` | `BJEE551` · `G111EH2` | `DBIS136ETA` · `FGJ11CH2` |

(measured on the two D0-01 recon frames that carry a human-legible plate: `cam21` = `RJ39CA5180`,
`cam06` = `GJ11CH2…`)

PP-OCR's detection stage is a segmentation model and needs the hard edges nearest preserves; the
fixed-slot recogniser is hurt by the aliasing those same edges introduce. **A single interpolation
flag was the difference between the PaddleOCR backend working and appearing to be broken.**
`OcrBackend.preferred_interpolation` now carries the choice.

The same class of bug: PP-OCR returns **no box at all** when the text region touches the image
border, so `rectify` leaves an 8% margin (`RECTIFY_MARGIN`).

### Which backend, and why the default is what it is

| | `fast_plate_ocr` | `paddle_ppocr` |
|---|---|---|
| exact reads on the 3 legible plates | 0 | 0 |
| **character accuracy on those plates** | **51.8%** | not measurable — read none of them |
| reads emitted across 120 instances | 51 | 7 |

`fast_plate_ocr` is the default. **A partial read is worth something and a silence is worth
nothing:** D2-04 exists to recover a plate from a string that is two characters wrong, and it has
nothing to work with when the recogniser abstains. The cost is 52 wrong strings against 7, which is
what the confidence floor and D2-04's scoring are for.

Either engine is selected by `SAAKSHI_OCR_BACKEND` or `--ocr-backend` with no code change.

---

## 8 · Throughput with ANPR on

```bash
python -m workers.analytics.run --cameras cam01 cam02 cam04 cam05 cam06 cam07 cam08 cam21 \
    --minutes 5 --anpr          # evidence/d2-01-anpr-run.json
```

8 of 8 sandbox cameras, 302.7 s measured window, Apple Silicon MPS for YOLO11 and ONNX Runtime CPU
for both ANPR models.

| | |
|---|---|
| cameras concurrent | **8 of 8**, 0 reconnects |
| frames decoded | 9,670 (**31.95 fps aggregate**) |
| sightings published -> rows inserted | 27,918 -> 27,918 |
| motion-gate skip ratio | 39.2% |
| **plate-detector calls** | **4,127** — p50 **252.0 ms**, p95 463.3 ms |
| **OCR calls** | **83** — p50 **19.2 ms**, p95 36.3 ms |
| tracks seen / voted plate reads | 640 / **15** |
| plate boxes below the 20 px width floor | 365 |
| votes below the confidence floor | 6 |

**The finding that matters for sizing: plate detection dominates, by two orders of magnitude.** It
runs once per tracked vehicle per examined frame (4,127 calls); OCR runs three times per *track*
(83 calls). Best-shot selection is doing exactly what it was built to do — and it is optimising the
cheaper of the two stages. **D3-08's sizing model must price the plate detector, not the OCR.**

Two consequences already measured:

- **Per-call plate-detector latency is a function of concurrency, not of the model.** The same model
  on the same machine measured **46 ms** p50 against one camera and **252 ms** p50 against eight,
  because eight decode threads serialise on one ONNX session behind a lock. An earlier run of the
  same command with the PP-OCR backend measured **789 ms** p50 with more contention still. A
  capacity claim taken at one camera would be wrong by 5x.
- **The obvious lever is the vehicle-size floor**, not a faster model: 365 of the plate boxes found
  were already below the width floor and 3,000+ vehicles were examined that could never have carried
  a readable plate. `VEHICLE_MIN_BOX_PX` and `MAX_EXAMINE_PER_TRACK` are where the compute is.

Recorded under the same caveat D1-09 gave: the sandbox gateway is upstream-bound, so this is what
the *government feed* delivers, not what the hardware can do.

### What 15 reads from 640 tracks look like

Every row carries text, confidence, `vote_count`, `is_best_shot` and a crop URI; none is null. The
content is the estate again:

```
757508300  0.888  cam05     <- the phone number on a roadside advertising hoarding
44671      0.732  cam08
GJ3266416  0.449  cam07     <- the only read with a plausible Indian plate shape
```

`757508300` is the highest-confidence read of the entire run and it is a **hoarding**, not a
vehicle. That single row is the argument for D2-06 never alerting on a raw read, and for D2-03's
grammar validation being a load-bearing filter rather than a formatting step.

---

## 9 · What this section is *not* claiming

- **No accuracy figure here is extrapolated.** Every rate names its denominator.
- **No live VAHAN or SARTHI lookup** validates any read. Those connectors are specified with a mock
  provider (`CLAUDE.md`); a plate here is a string from a camera, never a confirmed registration.
- **No face recognition.** Deliberately out of scope; no biometric data is processed anywhere in
  this pipeline. `person` is a bounding box and nothing is derived from it.
- **`normalized_text` is NULL on every row this ticket writes.** Normalisation and Indian-plate
  grammar validation are D2-03's, and the per-camera rejection rate is a trust signal that only
  exists if this column distinguishes "not normalised yet" from "normalised to nothing".
