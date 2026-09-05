# Limitations

> **Scope note.** `D4-08` owns the complete limitations-and-roadmap document. This file was created
> by **D3-03** because its acceptance criterion requires a measured number to be stated here, and a
> criterion that points at a file nobody has written yet is not satisfiable by intent. D4-08 should
> extend this document rather than replace it; the section below is a finished entry, not a stub.

An honest limitation with a number beside it is worth more than a claim without one. Everything here
was measured, and the command that measures it is given so anybody can re-run it.

---

## Vehicle re-ID bridging — built, measured at 0.761, **shipped disabled by default**

**What it is.** Bridging a sighting whose registration plate was unreadable to a vehicle identity
whose plate *was* read, using an appearance descriptor of the vehicle crop, gated first by the
D3-01 travel-time model. It exists because on this estate most plates cannot be read: of 120
hand-labelled vehicle instances in `fixtures/plate-eval`, **3 carry a plate a human can read**.

**The measurement.**

```bash
python -m workers.analytics.eval_reid --fixtures fixtures/reid-eval
```

| | value |
|---|---|
| **Held-out precision** (leave-one-camera-out, pooled) | **0.761** |
| Held-out recall | 0.593 |
| Target set by the ticket | 0.900 |
| Labelled pairs | 59 positive, 51 negative, all hand-verified |
| Cross-camera precision / recall | **unmeasured — see below** |

Full method, per-fold table and failure analysis: **`docs/reid.md`**. Raw output:
`docs/reid-measurement.json`.

**What that means in operational terms.** Roughly **one appearance link in four is wrong**. A wrong
link attaches another vehicle's movements to this vehicle's evidentiary route, which is materially
worse than a missing link — a missing link only leaves the route as sparse as ANPR alone would have
left it. So the feature is off unless someone turns it on, in three independent places:
`REID_ENABLED` (default false), `include_reid` on the trace endpoint (default false), and the trace
screen's checkbox (unticked). With it off, a trace is plate-only and unchanged.

**Three specific limitations, stated rather than implied.**

1. **Cross-camera performance is unmeasured, not good.** No cross-camera positive pair can be
   labelled on this estate: there is no plate anchor tying one vehicle to two cameras and no two
   sandbox cameras share a view. Worse, the diagnostic evidence points the wrong way — cross-camera
   similarities (mean 0.679) sit *below* same-camera negatives (mean 0.831), which indicates the
   descriptor separates **cameras** rather than **vehicles**. Cross-camera recall is therefore
   likely near zero, and cross-camera is what re-ID is for.
2. **Colour constancy is mitigated, not solved.** Six distinct resolutions and a measured luma range
   of 8.40–135.19 across the estate mean the same white car is a different colour on two cameras.
   Shades-of-grey white balance is applied before any colour comparison and measurably narrows the
   gap; what remains is item 1.
3. **No vehicle-re-ID-trained model ships.** None is available under a licence this project can
   accept without a procurement decision (`docs/model-licences.md` note 1). The shipped descriptor is
   classical. The already-present YOLO11 backbone was measured as the pretrained alternative and was
   **worse** — 0.714 precision, 0.339 recall — because a detection backbone is trained to make all
   cars look alike.

**A finding worth carrying beyond this feature.** Verifying the labelled set by eye showed that
**16 of 75 ByteTrack passes (21%) do not hold a single vehicle**: 9 identity switches, and 7 pairs no
human could adjudicate — two of which are not vehicles at all but roadside lettering the detector
fired on. Anything that treats "one track" as "one vehicle" inherits that error rate.

**This is not face recognition.** SAAKSHI processes no biometrics and stores no biometric template,
deliberately and for legal reasons. The descriptor above describes the outside of a vehicle — colour
histograms and edge orientations. See `docs/reid.md` §2.
