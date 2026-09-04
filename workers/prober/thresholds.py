"""Every threshold the prober uses, with the reason it has the value it has.

A threshold without a rationale is a magic number, and a magic number in a scoring system is what
turns "explainable" into "trust us". `docs/trust-score.md` is generated against this module, so a
constant changed here and not explained there is visible in review.

Calibration status is stated per constant. Several are calibrated against the D0-01 recon of the
real 30-camera estate; the rest are stated as provisional so D1-06 knows which numbers are measured
and which are still assumptions.
"""

from dataclasses import dataclass

# ── Timing ──────────────────────────────────────────────────────────────────────────────────────

#: Seconds of PTS discarded after connect before any frame counts toward `measured_fps`.
#:
#: The sandbox gateway replays a buffered GOP the moment you connect, so the first frames arrive in
#: a burst that has nothing to do with the camera's real frame rate — they are already-encoded
#: frames being flushed. Counting them inflates the measurement badly. 2.0 s spans a 6 s GOP's worth
#: of replay at the observed rates with margin; D0-01 measured GOPs of ~6 s on this estate.
BURST_DISCARD_S = 2.0

#: PTS window over which frames are counted, after the burst discard. The ticket specifies 30 s.
#: Overridable per run because a throttled gateway can take minutes to deliver 30 s of content —
#: see `MIN_FPS_SAMPLE_FRAMES` for what happens when it cannot.
FPS_WINDOW_S = 30.0

#: Below this many post-burst frames, `measured_fps` is reported as UNKNOWN rather than as a number.
#:
#: This distinction is the whole point. Closing D1-03 produced the evidence: `cam12` returned
#: "measured fps (unknown)" after a 516,783 ms probe and 20 fps after an 85,536 ms one — same code,
#: same camera, same cookie. A slow upstream and a broken camera must not write the same row, or the
#: trust score condemns a healthy camera for the network's sins.
MIN_FPS_SAMPLE_FRAMES = 10

#: Two PTS values closer than this are treated as the same instant.
#:
#: **Not cosmetic.** D1-03 measured PTS deltas of exactly 0.0 on `cam01`. Dividing by a zero gap
#: yields infinite frame rate here and, in D3-02, an impossible-transition alert against a vehicle
#: that did nothing wrong. Every divisor in this package is guarded by this floor.
MIN_PTS_DELTA_S = 1e-6

#: Fractional divergence between declared and measured FPS above which the camera is flagged.
#:
#: 0.15 rather than something tighter because encoders legitimately drift a few percent and a
#: variable-frame-rate source will never match its header exactly. The estate's real spread makes
#: the point: `cam01` declares 30 and delivers 15.4 (49% low), `cam12` declares 20 and delivers 20.
#: The flag has to catch the first without libelling the second.
FPS_DIVERGENCE_FRACTION = 0.15

# ── Focus ───────────────────────────────────────────────────────────────────────────────────────

#: Fraction of each dimension kept for the centre crop used by the blur measure.
#:
#: Centre crop, not full frame: these are wide-area traffic overviews with burned-in timestamp
#: overlays and channel banners at the edges (D0-01). Sharp overlay text on a blurred scene scores
#: a blurred camera as focused, which is exactly backwards.
BLUR_CROP_FRACTION = 0.5

#: Variance of the Laplacian below which a frame is considered out of focus.
#:
#: **Provisional — calibrated against D0-01's recon frames, not against a controlled test.** That
#: recon measured per-frame sharpness from 81.0 to 489.8 across the estate, night frames clustering
#: low and daylight frames high. 60.0 sits below the entire observed range, so it flags genuine
#: defocus rather than darkness. D1-06 should re-derive it from this ticket's published ranges.
BLUR_VARIANCE_MIN = 60.0

# ── Light ───────────────────────────────────────────────────────────────────────────────────────

#: Mean luma (0-255) below which a frame is too dark to be usable for plate reading.
#:
#: **Provisional.** D0-01 measured night frames at luma ~90 and daylight at ~110-138 on this estate,
#: so the recording is not pitch dark at night — it is streetlit. 40.0 marks "effectively black",
#: not "night": a camera that is merely dark is still worth probing, and calling every night camera
#: unusable would flag most of the estate for most of its 12-hour recording.
LUMA_DARK_MAX = 40.0

#: Mean luma above which a frame is blown out — a lamp or headlight staring into the lens.
LUMA_BLOWN_MIN = 235.0

# ── Tamper ──────────────────────────────────────────────────────────────────────────────────────

#: Median inter-frame absolute difference below which the scene is suspiciously static.
#:
#: A covered, frozen or spray-painted lens produces near-identical consecutive frames. Real traffic
#: overviews always carry motion — and even an empty road at night carries sensor noise, which is
#: why the floor can sit this low without flagging quiet scenes.
TAMPER_STATIC_DIFF_MAX = 1.5

#: Canny edge density below which the scene has lost its structure — the signature of an occluded
#: lens. A covered camera goes flat: no road edges, no lane markings, no poles.
TAMPER_EDGE_DENSITY_MIN = 0.012

#: Composite tamper score at or above which the camera is flagged.
#:
#: The composite is deliberately built from **medians over sampled frame pairs**, never means. A
#: mean is what makes the loop-point scene cut a false positive: the feeds loop, so one enormous
#: frame difference appears at the cut, and a mean-based static detector reads that single spike as
#: "definitely not static" while a mean-based change detector reads it as "everything changed".
#: A median over many pairs is unmoved by one outlier, which is what lets a real cut pass and a real
#: occlusion fail.
TAMPER_FLAG_MIN = 0.60

#: Frame pairs sampled across the window for the tamper statistics. Enough that a single scene cut
#: is one sample out of many rather than a decisive one.
TAMPER_SAMPLE_PAIRS = 12

# ── Clock ───────────────────────────────────────────────────────────────────────────────────────

#: |pts_drift_ms| above which a **live** camera's clock is considered wrong.
#:
#: A camera with a wrong clock corrupts every route reconstruction it contributes to (PROJECT.md §3)
#: — it is the one signal here whose failure silently poisons other people's answers rather than
#: just its own.
#:
#: **This threshold does not apply to a VOD source.** On the sandbox, `wall − pts` measures how much
#: faster than real time we pulled the file, which is a property of the network, not the camera.
#: `breakdown.pts_drift_meaning` records which of the two a given row is, so D1-06 can score the
#: live case and ignore the VOD case instead of penalising a whole estate for being a recording.
PTS_DRIFT_LIVE_MAX_MS = 2_000


@dataclass(frozen=True)
class Thresholds:
    """Runtime-overridable copy of the module constants, so a run can be tuned without an edit."""

    burst_discard_s: float = BURST_DISCARD_S
    fps_window_s: float = FPS_WINDOW_S
    min_fps_sample_frames: int = MIN_FPS_SAMPLE_FRAMES
    fps_divergence_fraction: float = FPS_DIVERGENCE_FRACTION
    blur_crop_fraction: float = BLUR_CROP_FRACTION
    blur_variance_min: float = BLUR_VARIANCE_MIN
    luma_dark_max: float = LUMA_DARK_MAX
    luma_blown_min: float = LUMA_BLOWN_MIN
    tamper_static_diff_max: float = TAMPER_STATIC_DIFF_MAX
    tamper_edge_density_min: float = TAMPER_EDGE_DENSITY_MIN
    tamper_flag_min: float = TAMPER_FLAG_MIN
    tamper_sample_pairs: int = TAMPER_SAMPLE_PAIRS
    min_pts_delta_s: float = MIN_PTS_DELTA_S
    pts_drift_live_max_ms: int = PTS_DRIFT_LIVE_MAX_MS


DEFAULTS = Thresholds()
