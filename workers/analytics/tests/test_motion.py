"""The motion gate (AC 7) and the loop-point scene-cut detector (AC 3), over real decoded frames.

Both are measured **in both directions**. A gate that skips everything would pass a static-clip test
and be useless; a cut detector that fires constantly would pass a scene-cut test and destroy every
track on the estate. So each has a positive case and a negative control.
"""

from __future__ import annotations

from pathlib import Path

import av
import numpy as np
import pytest

from workers.analytics.motion import MotionGate, SceneCutDetector, mean_abs_diff, thumbnail
from workers.analytics.thresholds import DEFAULTS

from .conftest import requires_ffmpeg


def frames_of(path: Path, limit: int = 200) -> list[np.ndarray]:
    container = av.open(str(path))
    try:
        stream = container.streams.video[0]
        out: list[np.ndarray] = []
        for frame in container.decode(stream):
            out.append(frame.to_ndarray(format="bgr24"))
            if len(out) >= limit:
                break
        return out
    finally:
        container.close()


def pts_of(path: Path, limit: int = 200) -> list[float]:
    container = av.open(str(path))
    try:
        stream = container.streams.video[0]
        time_base = float(stream.time_base or (1 / 90_000))
        out: list[float] = []
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            out.append(float(frame.pts) * time_base)
            if len(out) >= limit:
                break
        return out
    finally:
        container.close()


# ── The motion gate, both directions ────────────────────────────────────────────────────────────

@requires_ffmpeg
def test_the_gate_skips_almost_every_frame_of_a_static_scene(clips: dict[str, Path]) -> None:
    """Most cameras are idle most of the time; that idleness is the whole saving."""
    gate = MotionGate()
    images = frames_of(clips["static"])
    timestamps = pts_of(clips["static"])
    assert len(images) >= 50

    for image, pts in zip(images, timestamps, strict=False):
        gate.should_infer(thumbnail(image), pts)

    assert gate.skip_ratio >= 0.90, f"skip ratio {gate.skip_ratio:.3f} on a still image"


@requires_ffmpeg
def test_the_gate_skips_almost_nothing_when_the_scene_is_moving(clips: dict[str, Path]) -> None:
    """The other direction. Without this, a gate that always skipped would look excellent."""
    gate = MotionGate()
    images = frames_of(clips["moving"])
    timestamps = pts_of(clips["moving"])
    assert len(images) >= 50

    for image, pts in zip(images, timestamps, strict=False):
        gate.should_infer(thumbnail(image), pts)

    assert gate.skip_ratio <= 0.10, f"skip ratio {gate.skip_ratio:.3f} on continuous motion"


@requires_ffmpeg
def test_a_stopped_vehicle_is_still_inferred_because_of_the_keepalive(clips: dict[str, Path]) -> None:
    """A vehicle stopped at a signal produces no motion.

    Without the keep-alive its track ages out and it becomes a *new identity* when it moves off —
    which D2-08 would read as two vehicles.
    """
    gate = MotionGate()
    images = frames_of(clips["static"])
    # 4 seconds of PTS at 25 fps, keep-alive every 2 s -> at least one forced inference.
    for i, image in enumerate(images):
        gate.should_infer(thumbnail(image), i / 25.0)

    assert gate.keepalive_inferences >= 1


def test_the_gate_compares_against_the_last_inferred_frame_not_the_previous_one() -> None:
    """A vehicle crossing the frame one imperceptible step at a time must not be skipped forever.

    Each step here is below the threshold on its own; against a fixed reference they accumulate.
    """
    gate = MotionGate()
    base = np.zeros((90, 160), dtype=np.uint8)
    gate.should_infer(base.copy(), 0.0)

    fired = False
    for step in range(1, 40):
        creeping = base.copy()
        creeping[:, :step] = 255  # one more column each frame: ~1.6 mean units per step
        if gate.should_infer(creeping, step / 25.0):
            fired = True
            break
    assert fired, "a slow drift never reached the detector"


# ── The scene cut, both directions ──────────────────────────────────────────────────────────────

@requires_ffmpeg
def test_the_loop_point_scene_cut_is_detected(clips: dict[str, Path]) -> None:
    detector = SceneCutDetector()
    for image in frames_of(clips["scene_cut"]):
        detector.update(thumbnail(image))
    assert detector.cuts >= 1


@requires_ffmpeg
def test_the_fixture_cut_is_genuinely_larger_than_the_fixture_motion(clips: dict[str, Path]) -> None:
    """D1-05's rule: a cut test on a gentle fixture proves nothing.

    Measured here rather than assumed — the cut's frame difference must exceed the largest
    difference the *moving* clip ever produces, or the detector is only being asked to notice
    ordinary motion.
    """
    def diffs(path: Path) -> list[float]:
        thumbs = [thumbnail(f) for f in frames_of(path)]
        return [mean_abs_diff(a, b) for a, b in zip(thumbs, thumbs[1:], strict=False)]

    cut_diffs = diffs(clips["scene_cut"])
    motion_diffs = diffs(clips["gentle"])

    assert max(cut_diffs) > max(motion_diffs) * 2, (
        f"cut max {max(cut_diffs):.1f} vs motion max {max(motion_diffs):.1f} — "
        "the fixture does not actually contain a hard cut"
    )
    assert max(cut_diffs) >= DEFAULTS.scene_cut_diff_min


@requires_ffmpeg
def test_continuous_motion_is_not_mistaken_for_a_cut(clips: dict[str, Path]) -> None:
    """The negative control. Feeds loop once per cycle, not once per truck."""
    detector = SceneCutDetector()
    for image in frames_of(clips["gentle"]):
        detector.update(thumbnail(image))
    assert detector.cuts == 0


@requires_ffmpeg
def test_a_static_scene_is_not_mistaken_for_a_cut(clips: dict[str, Path]) -> None:
    """The case a ratio-only detector gets wrong: a median of ~0 makes any motion a huge multiple."""
    detector = SceneCutDetector()
    for image in frames_of(clips["static"]):
        detector.update(thumbnail(image))
    assert detector.cuts == 0


def test_a_resolution_change_mid_stream_is_a_discontinuity() -> None:
    detector = SceneCutDetector()
    assert detector.update(np.zeros((90, 160), dtype=np.uint8)) is False
    assert detector.update(np.zeros((45, 80), dtype=np.uint8)) is True


def test_the_median_divisor_is_floored_so_a_perfectly_static_feed_cannot_divide_by_zero() -> None:
    detector = SceneCutDetector()
    frame = np.full((90, 160), 128, dtype=np.uint8)
    for _ in range(DEFAULTS.scene_cut_min_history + 2):
        detector.update(frame.copy())
    assert detector.cuts == 0
    # Now a genuine cut against a history whose median is exactly 0.0.
    assert detector.update(np.zeros((90, 160), dtype=np.uint8)) is True


@requires_ffmpeg
def test_thumbnail_downscales_and_greys(clips: dict[str, Path]) -> None:
    image = frames_of(clips["h264_small"], limit=1)[0]
    thumb = thumbnail(image)
    assert thumb.ndim == 2
    assert thumb.shape[1] == DEFAULTS.motion_grey_width


def test_a_turbulent_stretch_produces_one_cut_not_one_per_frame() -> None:
    """The soak found this: `cam08` produced 25 tracking sessions in eleven seconds.

    Clearing the history on a cut leaves the ratio test unarmed, so every subsequent large frame
    difference clears the absolute floor on its own. A tracker reset 25 times in eleven seconds has
    not "reset cleanly at the cut" — it has stopped tracking. The refractory period is the fix.
    """
    detector = SceneCutDetector()
    calm = np.full((90, 160), 100, dtype=np.uint8)
    for _ in range(DEFAULTS.scene_cut_min_history + 4):
        detector.update(calm.copy())
    assert detector.cuts == 0

    rng = np.random.default_rng(1)
    for _ in range(30):
        detector.update(rng.integers(0, 255, (90, 160), dtype=np.uint8))

    assert detector.cuts <= 4, f"a noisy stretch produced {detector.cuts} cuts"
    assert detector.cuts >= 1, "the onset of turbulence was not detected at all"
