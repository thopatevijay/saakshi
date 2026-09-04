# Camera trust signals

**A registry that lists dead cameras is worse than no registry — it creates false assurance.**

This document specifies every signal the trust prober (`workers/prober/`, D1-05) measures: what it
is, how it is computed, the threshold it is judged against, and *why that threshold has the value it
has*. A threshold without a rationale is a magic number, and a magic number inside a scoring system
is what turns "explainable" into "trust us".

Scoring itself — turning these signals into `trust_score` 0–100 — is **D1-06**. This ticket measures;
it does not judge. `camera_health_checks.trust_score` is deliberately left `NULL` by the prober.

Everything here is **classical CV**: no model, no GPU, no weights to ship. At the 80,000-camera scale
the challenge describes, that is the difference between a feature and a budget line.

---

## 1 · The rules that shape every measurement

| Rule | Why |
|---|---|
| **All timing from PTS, never frame arrival time** | The sandbox gateway replays a buffered GOP the moment you connect. An arrival-time rate measures the speed of that flush, not the camera — and it is wrong on *every* reconnect. |
| **The first 2 s after connect are discarded** | That replayed GOP is already-encoded frames arriving at once. Counting them inflates the measured rate by more than 2× — see §2. |
| **Every divisor is floored** | D1-03 measured PTS deltas of exactly `0.0` on `cam01`. Dividing by that gap returns infinity, and an infinite frame rate propagates into D3-02 as an impossible-transition alert against a vehicle that did nothing wrong. |
| **Unmeasurable is `NULL`, never `0`** | "Too slow to measure" and "no measurable frame rate" are different facts. `cam12` measured *unknown* over a 516,783 ms probe and **20 fps** over an 85,536 ms one — same code, same camera, same cookie. Writing `0` would have condemned a healthy camera. |
| **A probe reports, it never raises** | A sweep of 80,000 cameras that aborts on the first unreachable one is not a sweep. |
| **A timeout is "retry later", never "unhealthy"** | D1-03 made this mistake once and it condemned healthy cameras. `breakdown.retryable` carries the distinction forward to D1-06. |
| **Join-time decoder warnings are logged, never fatal** | Connecting mid-GOP means the first frames reference an IDR we never received. libav complains, then recovers at the next keyframe. Treating that as failure marks the whole estate broken. |
| **Open only the camera being probed, and close it in a `finally`** | At 80,000 cameras a handle leaked once per probe exhausts the descriptor table long before the sweep ends — and it surfaces as *unrelated* cameras appearing unreachable. |

---

## 2 · The signals

### `connectable` — is it alive at all
The container opened. An HTTP 401/403 still counts as **connectable**: the gateway answered, and the
camera behind an expired cookie may be perfectly healthy. Dispatching a technician for an auth
failure wastes somebody's day.

### `decodable` — alive is not the same as usable
At least one frame decoded. A camera can accept a connection, serve a valid playlist, and deliver
nothing decodable; that is a distinct failure from being unreachable and is stored as one.

### `measured_fps` — the headline
Frames counted over a PTS window, after the connect burst is discarded.

```
fps = (frames_kept − 1) / (last_pts − first_pts)
```

`n` frames span `n − 1` intervals. Using `n` overstates the rate by `1/(n−1)`, which at these sample
sizes is a real error rather than a rounding one.

| Constant | Value | Rationale |
|---|---|---|
| `BURST_DISCARD_S` | `2.0` | Spans a 6 s GOP's worth of replay at the observed rates, with margin. D0-01 measured ~6 s GOPs on this estate. |
| `FPS_WINDOW_S` | `30.0` | The ticket's specification. Overridable per run with `--window`. |
| `MIN_FPS_SAMPLE_FRAMES` | `10` | Below this the answer is `NULL` **with a reason**, not a number. |
| `MIN_PTS_DELTA_S` | `1e-6` | The divide-by-zero floor. Not defensive padding — duplicate PTS are measured fact on this feed. |

**The discard is not a rounding detail.** With a 2 s replay burst at ~200 fps followed by 8 s of a
real 25 fps camera, the naive rate reads **> 55 fps** against a true **25**. The camera would be
recorded at more than twice its actual rate, and the declared-vs-measured delta — the entire point of
this ticket — would point the wrong way. `test_including_the_burst_would_give_a_materially_different_answer`
asserts exactly this.

### `declared` vs `measured` — the column that shows we read the guide
`fps_divergence_fraction = (measured − declared) / declared`, flagged at **±0.15**.

Loose enough that encoder drift and variable-frame-rate sources are not libelled; tight enough to
catch a camera running at half its claim. The real estate is why both halves matter:

| camera | declared | measured | verdict |
|---|---|---|---|
| `cam01` | 30 (container also reports `r_frame_rate 25/1` — self-contradictory) | **15.4** | overstated ~2× |
| `cam12` | 20 | **20** | accurate |

**The estate does not uniformly lie.** A claim that it does would be contradicted by `cam12` in front
of the jury. The honest framing is: *declared values are unverifiable until measured — some are
right, some are out by 2×, and you cannot tell which without measuring.*

On the deployed sandbox every `cameras.declared_fps` is `NULL`, because the catalogue supplies only
`{id, name}`. A camera whose department declared nothing cannot be caught lying — that absence is
itself the Pillar 1 finding, and it is reported rather than filled in.

### `actual_resolution` / `actual_codec`
Read from the decoded frame, not from the container header. Confirms the estate is heterogeneous:
`cam01` is 1920×1080, `cam12` is 1280×720. Nothing may be assumed estate-wide.

### `blur_score` — focus
Variance of the Laplacian on a **centre crop** (`BLUR_CROP_FRACTION = 0.5`), median across sampled
frames.

- **Centre crop, not full frame.** These feeds carry burned-in timestamp overlays and channel banners
  around the edges (D0-01). Overlay text is permanently, perfectly sharp, so a full-frame measure
  reports a blurred camera as focused — it would be measuring the overlay, not the scene.
- **Median, not mean.** One frame ruined by headlight glare should not decide whether a camera is in
  focus.

`BLUR_VARIANCE_MIN = 60.0` — **provisional**, sitting below the entire range D0-01 observed
(81.0–489.8), so it flags genuine defocus rather than darkness.

### `luma_mean` / `night_usable` — light
Mean luma (0–255), median across sampled frames.

`night_usable` is deliberately **not** "is it night". The recording runs roughly 21:00→09:00, so most
of it is dark; a flag that fired on darkness would condemn most of the estate for most of its
footage. It fires on the conditions under which *no plate can be read at any hour*:

| Condition | Threshold | Rationale |
|---|---|---|
| effectively black | `luma ≤ 40.0` | D0-01 measured night frames at luma ~90 — this estate is streetlit, not pitch dark. 40 marks "black", not "night". |
| blown out | `luma ≥ 235.0` | A lamp or headlight staring into the lens. |
| out of focus | `blur < 60.0` | Bright and sharp are both required. |

### `tamper_score` — occlusion, freezing, spray paint
A composite in `[0, 1]`; higher is more suspicious. Two independent pieces of evidence, because
either alone is wrong:

- **Static scene** — median absolute difference between consecutive sampled frames
  (`TAMPER_STATIC_DIFF_MAX = 1.5`). A covered, frozen or painted lens produces near-identical
  frames. Real traffic overviews always carry motion, and even an empty road at night carries sensor
  noise, which is why the floor can sit this low without flagging quiet scenes.
- **Edge collapse** — median Canny edge density (`TAMPER_EDGE_DENSITY_MIN = 0.012`). An occluded lens
  loses the road edges, lane markings and poles a working one always sees.

```
static_component = clamp(1 − median_frame_diff / 1.5)
edge_component   = clamp(1 − median_edge_density / 0.012)
tamper_score     = (static_component + edge_component) / 2
flagged          = tamper_score ≥ 0.60
```

The two are **averaged rather than required together**: a replayed still image is tampering too, and
it has plenty of edges. An edges-only test would pass it as healthy.

#### Why both statistics are medians — this is an acceptance criterion, not a style choice

**The feeds loop.** Every long window contains one hard scene cut. Under a *mean*, that single
enormous frame difference dominates: a genuinely covered camera reads as active, and a normal camera
reads as "everything changed". A median over `TAMPER_SAMPLE_PAIRS = 12` samples is unmoved by one
outlier, so the loop point passes and real occlusion still fails.

`max_frame_diff` is retained in the breakdown so the cut stays **visible** in the record — it is
reported, it just does not get a vote.

Proven twice: once over synthetic frames, and once over a real `testsrc → smptebars` cut encoded and
re-demuxed through the actual probe path. The synthetic fixture carries its own honesty guard,
asserting the cut is genuinely larger than ordinary motion, so the test cannot pass by being too
gentle. **That guard rejected two earlier fixtures** built on random noise — where consecutive frames
already differ by ~50 grey levels and a cut is indistinguishable from motion.

### `pts_drift_ms` — clock
`(wall_elapsed − pts_elapsed) × 1000` over the measured window.

**Its meaning depends on the source, and the row says which.** `breakdown.pts_drift_meaning` records
one of two strings:

| Source | Meaning | Score it? |
|---|---|---|
| **live** | Encoder clock against wall clock. `PTS_DRIFT_LIVE_MAX_MS = 2000`. | **Yes.** A camera with a wrong clock corrupts every route reconstruction it contributes to — it is the one signal whose failure poisons *other people's* answers, not just its own. |
| **VOD** (what the sandbox serves) | Pull-rate skew. Positive = the file arrived slower than real time; negative = faster. | **No.** Measured here: `cam01` +2,400 ms and `cam12` +98,780 ms across ~10 s of content — that is the gateway throttling, not a camera fault. |

Reporting a network property as a clock fault would condemn an entire estate for being a recording
behind a slow link. The distinction is carried in the row so D1-06 cannot lose it.

---

## 3 · What gets written

One `camera_health_checks` row per camera per pass. It is a Timescale hypertable keyed
`(camera_id, checked_at)`, so **every pass appends and none overwrites** — that is what makes the
worker idempotent in the sense that matters: re-running costs another row and changes no history.

`breakdown` (jsonb) carries measurement provenance so D1-06 can calibrate against real data and the
UI can explain the number rather than assert it:

```jsonc
{
  "pass_id": "…",                  // one uuid per sweep — proves one row per camera per pass
  "probe_ms": 84329,
  "decoder_warnings_benign": [...],       // logged, never fatal
  "decoder_warnings_benign_count": 12,
  "decoder_warnings_unexpected": [],
  "fps": {
    "measured": 15.0, "declared": null, "divergence_fraction": null, "diverged": false,
    "frames_counted": 150, "frames_discarded_as_connect_burst": 50,
    "pts_span_s": 9.94, "window_s": 30.0, "burst_discard_s": 2.0,
    "unmeasurable_reason": null           // set instead of a number when it could not be measured
  },
  "tamper": { "score": 0.0, "flagged": false, "median_frame_diff": …,
              "median_edge_density": …, "max_frame_diff": …, "pairs_sampled": 12 },
  "light":  { "luma_mean": 99.53, "blur_score": 130.822, "night_usable": true },
  "source_is_vod": true,
  "pts_drift_meaning": "vod_pull_rate_skew — …",
  "wall_span_s": 12.34,
  "error": "…", "retryable": true        // present only on failure
}
```

---

## 4 · Running it

```bash
python -m workers.prober.run --once --all              # one sweep of every active camera
python -m workers.prober.run --once --camera cam01     # one camera
python -m workers.prober.run --once --all --pool 8 --window 10
python -m workers.prober.run --interval 900 --all      # scheduled sweep
python -m workers.prober.run --once --all --include-absent
```

**Scope.** "Every active camera" resolves to `deleted_at IS NULL AND catalogue_status = 'active'`.
`camera_status` has no `'active'` value — it is `unknown|online|degraded|offline`, and it is this
worker's *output*, not its input — so `catalogue_status` is the only literal reading.
`--include-absent` covers the other one: a camera delisted upstream that still serves frames is
itself a Pillar 1 finding.

**Pool.** Default 4, `--pool` to change. Modest on purpose: the sandbox gateway throttles roughly
tenfold under sustained use, and hammering it makes every camera look worse — the measurement would
then describe our own load rather than the estate.

**URL resolution.** `endpoints` from the registry wins. `GET /api/ingest` is the contract; the URL
pattern is not, so the fallback is a configurable template (`SENTINEL_STREAM_TEMPLATE`), never a
constant compiled into the worker.
