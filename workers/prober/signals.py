"""The trust signals, as pure functions.

Everything here takes frames or PTS values and returns a number. No network, no database, no
decoder. That is deliberate: the two acceptance criteria most likely to be waved through — "a
covered feed scores high tamper" and "the loop-point scene cut does not" — become ordinary unit
tests over synthetic input instead of claims about a live stream nobody can re-run.

All classical CV. No model, no GPU, no weights to ship. At 80,000 cameras that is the difference
between a feature and a budget line.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass

import cv2
import numpy as np

from .thresholds import Thresholds, DEFAULTS

Frame = np.ndarray


# ── Frame rate, from PTS ────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FpsMeasurement:
    """The result of counting frames over a PTS window.

    `fps is None` means *could not measure*, which is a different fact from a low frame rate and is
    stored as NULL rather than as a number. Closing D1-03 produced the evidence for keeping them
    apart: the same camera measured "unknown" over a 517 s probe and 20 fps over an 86 s one.
    """

    fps: float | None
    frames_counted: int
    frames_discarded: int
    pts_span_s: float
    reason: str | None = None


def measure_fps(
    pts_seconds: list[float],
    thresholds: Thresholds = DEFAULTS,
) -> FpsMeasurement:
    """Frames per second over the PTS window, with the connect burst discarded.

    `pts_seconds` is the presentation timestamp of each decoded frame, in seconds, in decode order.
    **Arrival time is never an input here.** The gateway replays a buffered GOP on connect, so an
    arrival-time rate is wrong on every single reconnect — it reports the speed of the flush, not
    the speed of the camera.

    Two guards that are not defensive padding:

    - Frames within `burst_discard_s` of the first PTS are dropped. Those are the replayed GOP.
    - The PTS span is floored at `MIN_PTS_DELTA_S`. D1-03 measured PTS deltas of exactly 0.0 on
      `cam01`; dividing by that gap gives infinity, and an infinite frame rate propagates into
      D3-02 as an impossible-transition alert against an innocent vehicle.
    """
    if not pts_seconds:
        return FpsMeasurement(None, 0, 0, 0.0, "no frames decoded")

    ordered = sorted(pts_seconds)
    first = ordered[0]
    cutoff = first + thresholds.burst_discard_s

    kept = [p for p in ordered if p >= cutoff]
    discarded = len(ordered) - len(kept)

    if len(kept) < thresholds.min_fps_sample_frames:
        return FpsMeasurement(
            None,
            len(kept),
            discarded,
            0.0 if not kept else kept[-1] - kept[0],
            f"only {len(kept)} frames after discarding the {discarded}-frame connect burst; "
            f"need {thresholds.min_fps_sample_frames}. Usually a throttled upstream, not a dead camera",
        )

    span = kept[-1] - kept[0]
    if span < thresholds.min_pts_delta_s:
        # Every frame carried the same timestamp. D1-03 measured exactly this on `cam01`: PTS deltas
        # of 0.0. Dividing here would return infinity and publish it as a frame rate.
        return FpsMeasurement(
            None,
            len(kept),
            discarded,
            span,
            f"PTS span collapsed to {span:.9f}s across {len(kept)} frames — duplicate timestamps",
        )

    # n frames span n-1 intervals. Using n here overstates the rate by 1/(n-1), which at the sample
    # sizes involved is a real error, not a rounding one.
    fps = (len(kept) - 1) / span
    return FpsMeasurement(round(fps, 2), len(kept), discarded, round(span, 3))


def fps_divergence(
    declared: float | None,
    measured: float | None,
    thresholds: Thresholds = DEFAULTS,
) -> tuple[float | None, bool]:
    """`(fractional divergence, flagged)` between what was declared and what was measured.

    Returns `(None, False)` when either side is missing — an unmeasurable camera is not a diverging
    one, and a camera whose department declared nothing cannot be caught lying. On the sandbox every
    `declared_fps` is NULL, because the catalogue supplies only `{id, name}`; that absence is itself
    the Pillar 1 finding, and it is reported rather than filled in.
    """
    if declared is None or measured is None or declared <= 0:
        return None, False
    divergence = (measured - declared) / declared
    return round(divergence, 4), abs(divergence) >= thresholds.fps_divergence_fraction


def pts_drift_ms(pts_span_s: float, wall_span_s: float) -> int:
    """Wall-clock time minus PTS time over the same window, in milliseconds.

    On a **live** camera this is encoder clock drift, and it matters more than it looks: a camera
    with a wrong clock corrupts every route reconstruction it contributes to, which is somebody
    else's answer being wrong rather than its own.

    On a **VOD** source — which is what the sandbox serves — the same arithmetic measures how much
    faster than real time the file was pulled, a property of the network. The number is reported
    honestly either way and `breakdown.pts_drift_meaning` records which one it is, so D1-06 can
    score the live case without condemning an entire estate for being a recording.
    """
    return int(round((wall_span_s - pts_span_s) * 1000.0))


# ── Focus ───────────────────────────────────────────────────────────────────────────────────────


def centre_crop(frame: Frame, fraction: float = DEFAULTS.blur_crop_fraction) -> Frame:
    """The middle `fraction` of each dimension.

    These feeds carry burned-in timestamp overlays and channel banners around the edges (D0-01).
    Overlay text is permanently, perfectly sharp, so a full-frame focus measure reports a blurred
    camera as focused — the metric would be measuring the overlay, not the scene.
    """
    height, width = frame.shape[:2]
    crop_h, crop_w = int(height * fraction), int(width * fraction)
    top, left = (height - crop_h) // 2, (width - crop_w) // 2
    return frame[top : top + crop_h, left : left + crop_w]


def to_grey(frame: Frame) -> Frame:
    if frame.ndim == 2:
        return frame
    return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)


def blur_score(frames: list[Frame], thresholds: Thresholds = DEFAULTS) -> float | None:
    """Variance of the Laplacian on the centre crop — higher is sharper.

    Median across sampled frames rather than mean: a single frame ruined by headlight glare or a
    passing lorry should not decide whether a camera is in focus.
    """
    if not frames:
        return None
    values = [
        float(cv2.Laplacian(to_grey(centre_crop(f, thresholds.blur_crop_fraction)), cv2.CV_64F).var())
        for f in frames
    ]
    return round(statistics.median(values), 3)


# ── Light ───────────────────────────────────────────────────────────────────────────────────────


def luma_mean(frames: list[Frame]) -> float | None:
    """Mean luma (0-255), median across sampled frames."""
    if not frames:
        return None
    return round(statistics.median(float(to_grey(f).mean()) for f in frames), 2)


def night_usable(
    luma: float | None,
    blur: float | None,
    thresholds: Thresholds = DEFAULTS,
) -> bool | None:
    """Whether the frame is bright enough and sharp enough to read a plate from.

    Deliberately **not** "is it night". The sandbox recording runs roughly 21:00 to 09:00, so most
    of it is dark, and a flag that fired on darkness would condemn most of the estate for most of
    its footage. This fires on *effectively black* or blown-out, plus defocus — the conditions under
    which no plate can be read regardless of the hour.
    """
    if luma is None:
        return None
    if luma <= thresholds.luma_dark_max or luma >= thresholds.luma_blown_min:
        return False
    if blur is not None and blur < thresholds.blur_variance_min:
        return False
    return True


# ── Tamper ──────────────────────────────────────────────────────────────────────────────────────


def edge_density(frame: Frame) -> float:
    """Fraction of pixels that are Canny edges. A covered lens goes flat and loses its structure."""
    edges = cv2.Canny(to_grey(frame), 100, 200)
    return float(np.count_nonzero(edges)) / float(edges.size)


@dataclass(frozen=True)
class TamperMeasurement:
    score: float
    flagged: bool
    median_frame_diff: float
    median_edge_density: float
    max_frame_diff: float
    pairs_sampled: int


def tamper_score(frames: list[Frame], thresholds: Thresholds = DEFAULTS) -> TamperMeasurement | None:
    """Composite occlusion/tamper score in [0, 1]. Higher is more suspicious.

    Two independent pieces of evidence, because either alone is wrong:

    - **Static scene** — the median absolute difference between consecutive sampled frames. A
      covered, frozen or spray-painted lens produces near-identical frames. Real traffic overviews
      always carry motion, and even an empty road at night carries sensor noise.
    - **Edge collapse** — median Canny edge density. An occluded lens loses the road edges, lane
      markings and poles that a working one always sees.

    **Both statistics are medians, and that is the acceptance criterion, not a stylistic choice.**
    These feeds loop, so a hard scene cut appears in every long window. Under a *mean*, that single
    enormous frame difference makes a genuinely covered camera look active. A median over
    `tamper_sample_pairs` samples is unmoved by one outlier, so the loop point passes and the
    occlusion still fails. `max_frame_diff` is retained separately so the cut is still *visible* in
    the breakdown — it is reported, just not allowed to vote.
    """
    if len(frames) < 2:
        return None

    step = max(1, len(frames) // max(1, thresholds.tamper_sample_pairs))
    sampled = frames[::step]
    if len(sampled) < 2:
        sampled = frames[:2]

    diffs = [
        float(np.mean(cv2.absdiff(to_grey(a), to_grey(b))))
        for a, b in zip(sampled, sampled[1:])
    ]
    densities = [edge_density(f) for f in sampled]

    median_diff = statistics.median(diffs)
    median_density = statistics.median(densities)

    # Each component is a 0-1 "how far past the threshold, in the bad direction" ratio, clamped.
    static_component = _clamp(1.0 - (median_diff / thresholds.tamper_static_diff_max))
    edge_component = _clamp(1.0 - (median_density / thresholds.tamper_edge_density_min))

    # Mean of the two: an occluded lens usually trips both, and requiring both (a product) would
    # miss a frozen frame that still shows a sharp scene — a replayed still image is tampering too.
    score = round((static_component + edge_component) / 2.0, 3)

    return TamperMeasurement(
        score=score,
        flagged=score >= thresholds.tamper_flag_min,
        median_frame_diff=round(median_diff, 3),
        median_edge_density=round(median_density, 5),
        max_frame_diff=round(max(diffs), 3),
        pairs_sampled=len(diffs),
    )


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))
