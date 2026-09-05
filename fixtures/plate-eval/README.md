# `fixtures/plate-eval` — the hand-labelled ANPR evaluation set

The set the numbers in `docs/anpr-accuracy.md` are measured on. Built from the Sentinel sandbox
feeds, labelled **by eye**, and reproducible end to end.

```
frames/          captured JPEGs, one per sampled instant   (gitignored — large, and re-fetchable)
crops/           vehicle and plate crops, upscaled for human inspection
sheets/          contact sheets: numbered grids used for labelling
labels.json      the manifest — one entry per vehicle instance, with the human's verdict
```

## How it was built

```bash
# 1 · capture. Daylight sits at offsets ~32400-43200 s; the recording runs 21:00 -> 09:00 (D0-01).
python -m workers.analytics.anpr.dataset capture --cameras cam21 cam06 cam10 \
    --condition day   --offset 39600 --seconds 90 --fps 2
python -m workers.analytics.anpr.dataset capture --cameras cam21 cam06 cam10 \
    --condition night --offset 7200  --seconds 90 --fps 2

# 2 · mine vehicle instances, in two stated strata
python -m workers.analytics.anpr.dataset mine --condition day
python -m workers.analytics.anpr.dataset mine --condition night

# 3 · contact sheets, then label labels.json by eye
python -m workers.analytics.anpr.dataset sheet --condition day
python -m workers.analytics.anpr.dataset status

# 4 · measure
python -m workers.analytics.eval_anpr --fixtures fixtures/plate-eval --compare
```

## What an instance is, and why

The sampling unit is a **vehicle box from D1-09's YOLO11 detector**, not a plate-detector proposal.
Ground truth must not come from the thing being measured: a set built from plate proposals can only
measure precision, because every plate the detector missed would be missing from the ground truth
too and recall would be 1.0 by construction.

So each instance is a vehicle a plate-blind detector found, and a human then recorded:

| field | meaning |
|---|---|
| `plate_visible` | `true` when a human can see a plate region at all, readable or not. `null` = not yet labelled. |
| `label` | the string a human reads, or `null` when no human can read it. **Never filled by a model.** |
| `note` | why it is unreadable, or what makes it hard. This is what `docs/anpr-accuracy.md`'s "where it fails" section is built from. |
| `stratum` | `representative` or `enriched` — see below |
| `plate_box`, `plate_conf`, `plate_width_px` | what the plate detector found. Recorded *before* labelling and never shown as a hint. |

## Two strata, never averaged

- **`representative`** — a uniform random sample (seeded, `20260905`) of vehicle instances above the
  pipeline's own size floor. Answers *what does this estate actually yield?*
- **`enriched`** — the largest plate-bearing instances available. Answers *when this estate does
  present a readable plate, does the pipeline read it?*

A single blended number would describe neither. On an estate of wide-area PTZ cameras it would be
dominated by vehicles whose plates are ten pixels across, and it would make the OCR stage look
broken when the truth is that the camera never showed it a plate.

## Labelling rules used

1. **Read the crop at its native pixels, upscaled nearest-neighbour.** Cubic interpolation invents
   plausible glyph edges, and a label read off an invention is not ground truth.
2. **If uncertain between two characters, the plate is not legible.** `label` stays `null` and the
   `note` records the ambiguity. A guessed label makes the pipeline look wrong when it was right, or
   right when it was wrong; either way the measurement stops meaning anything.
3. **A partly-occluded plate whose visible characters are certain is still `label: null`** — the
   pipeline is scored on the whole string, so half a truth is a false label.
4. **`plate_visible: true` with `label: null` is a real and common outcome**, and it is the most
   informative one on this estate: the plate is there, and no human can read it. Those instances are
   the denominator of nothing, but they are the numerator of the honest story.

## Regenerating

`frames/` is gitignored — it is tens of megabytes of re-fetchable JPEG. `crops/`, `sheets/` and
`labels.json` are committed, because they are the evidence: the crops are what was labelled, and a
number measured on a set nobody else can see is not a measurement.
