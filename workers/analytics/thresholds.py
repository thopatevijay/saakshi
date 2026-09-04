"""Every analytics threshold, with the reason it has the value it has.

Timing constants are **imported from `workers.prober.thresholds`, never redefined**. `BURST_DISCARD_S`
and `MIN_PTS_DELTA_S` are the two that D1-03 and D1-05 paid for empirically; a second copy that
drifts from the first is how a measured constant quietly becomes a magic number.
"""

from __future__ import annotations

from dataclasses import dataclass

from workers.prober.thresholds import BURST_DISCARD_S, MIN_PTS_DELTA_S

__all__ = [
    "BURST_DISCARD_S",
    "MIN_PTS_DELTA_S",
    "AnalyticsThresholds",
    "DEFAULTS",
    "MOTION_DIFF_MIN",
    "MOTION_GREY_WIDTH",
    "MOTION_KEEPALIVE_PTS_S",
    "SCENE_CUT_DIFF_MIN",
    "SCENE_CUT_MEDIAN_RATIO",
    "SCENE_CUT_MIN_HISTORY",
    "SCENE_CUT_HISTORY",
    "DETECT_CONFIDENCE_MIN",
    "DETECT_IOU",
    "IMGSZ_STEPS",
    "IMGSZ_MAX",
    "IMGSZ_MIN",
    "TRACK_SESSION_STRIDE",
    "STALL_WARN_S",
    "OPEN_TIMEOUT_S",
    "READ_TIMEOUT_S",
]

# ── Motion gate ─────────────────────────────────────────────────────────────────────────────────

#: Width, in pixels, of the greyscale thumbnail the motion gate compares.
#:
#: The gate must cost far less than the inference it avoids or it is not a saving. A 160-px-wide
#: grey frame is ~0.05 MPix against 2.07 MPix at 1920x1080 — a 40x reduction — and is still far
#: above the scale at which a vehicle entering the frame moves a detectable number of pixels.
MOTION_GREY_WIDTH = 160

#: Mean absolute 0-255 difference against the last *inferred* frame, below which a frame is skipped.
#:
#: Compared against the last inferred frame rather than the previous frame on purpose: consecutive
#: frames in slow motion each differ by almost nothing, so a previous-frame comparison would skip a
#: vehicle crossing the whole frame one imperceptible step at a time.
#:
#: PROVISIONAL. 1.5 is the prober's static-scene threshold (`TAMPER_STATIC_DIFF_MAX`), measured on
#: this estate; the gate uses the same figure so "static" means one thing in both workers.
MOTION_DIFF_MIN = 1.5

#: Force an inference every N seconds of **PTS** regardless of the gate.
#:
#: A vehicle stopped at a signal produces no motion. Without a keep-alive its track ages out and it
#: reappears as a new identity when it moves off — which D2-08 would read as two vehicles. Two
#: seconds is below ByteTrack's default 30-frame (~1 s at 25 fps) buffer only for slow feeds, so the
#: tracker is refreshed at least as often as it forgets on the estate's modal rates.
MOTION_KEEPALIVE_PTS_S = 2.0

# ── Scene cut (the loop point) ──────────────────────────────────────────────────────────────────

#: Absolute floor for a hard cut: mean absolute grey difference against the previous frame.
#:
#: Both conditions must hold — the absolute floor *and* the ratio below. The floor alone fires on a
#: pan or a lighting change; the ratio alone fires on the first real movement in a static scene,
#: because a rolling median of near-zero makes any motion look like a multiple of it.
SCENE_CUT_DIFF_MIN = 22.0

#: A cut must also be this many times the rolling **median** of recent frame differences.
#:
#: Median, not mean, for D1-05's reason: the mean of a window containing the cut is dragged up by
#: the cut itself, so a mean-based detector is quietest exactly where it must be loudest.
SCENE_CUT_MEDIAN_RATIO = 4.0

#: Frame differences kept for that median.
SCENE_CUT_HISTORY = 30

#: Below this much history the ratio test is not applied — only the absolute floor.
#:
#: With three samples a median is not a statistic. The first frames after a connect are also the
#: replayed GOP, where differences are least representative of the feed.
SCENE_CUT_MIN_HISTORY = 8

# ── Detection ───────────────────────────────────────────────────────────────────────────────────

#: Minimum YOLO confidence for a detection to enter the tracker.
#:
#: PROVISIONAL — no precision/recall measurement exists yet (D2-01 owns that). 0.25 is ultralytics'
#: own default and is stated as inherited rather than as calibrated, because CLAUDE.md forbids
#: claiming an accuracy number nobody measured.
DETECT_CONFIDENCE_MIN = 0.25

#: NMS IoU. ultralytics' default, inherited for the same reason.
DETECT_IOU = 0.45

#: Legal inference sizes. YOLO strides by 32, so anything else is silently rounded by ultralytics.
IMGSZ_STEPS = 32
IMGSZ_MIN = 320
#: Cap. 1920-px inference on eight concurrent 1080p streams is an order of magnitude more compute
#: for detections a 960-px pass already finds at traffic-camera object sizes.
IMGSZ_MAX = 960

# ── Tracking ────────────────────────────────────────────────────────────────────────────────────

#: `track_id = session_index * TRACK_SESSION_STRIDE + tracker_id`.
#:
#: ByteTrack restarts its counter at 1 after `reset()`, so ids from before and after a loop-point cut
#: would collide in the database and D2-08 would link two unrelated vehicles. The offset makes
#: "no identity bleed across the cut" a property that can be *queried* rather than asserted:
#: `track_id / TRACK_SESSION_STRIDE` is the session, and no session spans a cut by construction.
#: 100_000 sits inside `sightings.track_id`'s int4 column for ~21,000 sessions per camera.
TRACK_SESSION_STRIDE = 100_000

# ── Deadlines ───────────────────────────────────────────────────────────────────────────────────

#: Seconds to open a container before giving up and retrying.
#:
#: Sized for the slow case, deliberately: one D1-03 probe of this estate took 516,783 ms, and one
#: 1.3 KB catalogue fetch has measured 63 s. A short timeout here does not make the gateway faster,
#: it just relabels a slow network as a broken camera — the exact mistake D1-05 made twice.
OPEN_TIMEOUT_S = 300.0

#: Read deadline once open. Same reasoning; a throttled segment fetch is not a dead stream.
#:
#: It is also the worker's only way out of a blocking decode: PyAV exposes no interrupt callback, so
#: a thread told to stop leaves the loop at the next frame *or* at this deadline, whichever comes
#: first. Two minutes is far above the ~0.34 s mean inter-frame wall gap measured on this estate and
#: far below the 516 s a throttled *open* has taken, so it ends a stopped run without turning a slow
#: segment fetch into a spurious reconnect.
READ_TIMEOUT_S = 120.0

#: Wall seconds without a frame before the watchdog logs upstream starvation.
#:
#: A log line, never an action. The point is to record *that the gateway stalled*, separately from
#: our own loop time, so a throughput number can say which of the two it measured.
STALL_WARN_S = 30.0


@dataclass(frozen=True)
class AnalyticsThresholds:
    """Overridable per run, so a test can make the gate strict or loose without patching globals."""

    burst_discard_s: float = BURST_DISCARD_S
    min_pts_delta_s: float = MIN_PTS_DELTA_S
    motion_grey_width: int = MOTION_GREY_WIDTH
    motion_diff_min: float = MOTION_DIFF_MIN
    motion_keepalive_pts_s: float = MOTION_KEEPALIVE_PTS_S
    scene_cut_diff_min: float = SCENE_CUT_DIFF_MIN
    scene_cut_median_ratio: float = SCENE_CUT_MEDIAN_RATIO
    scene_cut_history: int = SCENE_CUT_HISTORY
    scene_cut_min_history: int = SCENE_CUT_MIN_HISTORY
    detect_confidence_min: float = DETECT_CONFIDENCE_MIN
    detect_iou: float = DETECT_IOU
    imgsz_max: int = IMGSZ_MAX
    imgsz_min: int = IMGSZ_MIN
    track_session_stride: int = TRACK_SESSION_STRIDE
    stall_warn_s: float = STALL_WARN_S
    open_timeout_s: float = OPEN_TIMEOUT_S
    read_timeout_s: float = READ_TIMEOUT_S


DEFAULTS = AnalyticsThresholds()
