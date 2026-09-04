"""Unit tests for the trust signals. No network, no database, no decoder."""

from __future__ import annotations

import numpy as np
import pytest

from workers.prober import signals
from workers.prober.thresholds import DEFAULTS


# ── AC 2 · measured_fps from PTS, excluding the connect burst ───────────────────────────────────


class TestConnectBurstIsExcluded:
    def test_frames_inside_the_burst_window_are_dropped(self) -> None:
        # 2 s of replayed GOP at an absurd 200 fps, then 8 s of the camera's real 25 fps. This is
        # the shape the gateway actually produces: a flush of already-encoded frames on connect,
        # then the live rate.
        burst = [i / 200.0 for i in range(400)]
        real = [2.0 + i / 25.0 for i in range(200)]

        measured = signals.measure_fps(burst + real)

        assert measured.frames_discarded == 400
        assert measured.frames_counted == 200
        assert measured.fps == pytest.approx(25.0, abs=0.2)

    def test_including_the_burst_would_give_a_materially_different_answer(self) -> None:
        """The discard has to *matter*, or the test proves nothing.

        Without it the same input reads as ~60 fps against a true 25 — the camera would be recorded
        as running at more than twice its actual rate, and the declared-vs-measured delta, which is
        the whole point of this ticket, would point the wrong way.
        """
        burst = [i / 200.0 for i in range(400)]
        real = [2.0 + i / 25.0 for i in range(200)]
        combined = burst + real

        with_discard = signals.measure_fps(combined).fps
        naive = (len(combined) - 1) / (max(combined) - min(combined))

        assert with_discard == pytest.approx(25.0, abs=0.2)
        assert naive > 55.0
        assert abs(naive - with_discard) > 25.0

    def test_the_boundary_frame_is_excluded_not_included(self) -> None:
        # A frame exactly at the cutoff belongs to the measurement, one just inside does not.
        pts = [0.0, 1.999, 2.0] + [2.0 + i / 25.0 for i in range(1, 30)]
        measured = signals.measure_fps(pts)
        assert measured.frames_discarded == 2


class TestUnmeasurableIsNotZero:
    def test_too_few_frames_reports_none_with_a_reason(self) -> None:
        """A throttled upstream and a dead camera must not write the same row.

        Closing D1-03 produced the evidence: cam12 measured "unknown" over a 517 s probe and 20 fps
        over an 86 s one. Same code, same camera. Storing 0 here would have condemned it.
        """
        measured = signals.measure_fps([2.0 + i / 25.0 for i in range(5)])
        assert measured.fps is None
        assert measured.reason is not None
        assert "throttled upstream" in measured.reason

    def test_no_frames_at_all(self) -> None:
        assert signals.measure_fps([]).fps is None

    def test_duplicate_pts_never_divides_by_zero(self) -> None:
        """D1-03 measured PTS deltas of exactly 0.0 on cam01.

        Dividing by that gap returns infinity, and an infinite frame rate propagates into D3-02 as
        an impossible-transition alert against a vehicle that did nothing wrong.
        """
        measured = signals.measure_fps([5.0] * 400)
        assert measured.fps is None
        assert measured.fps != float("inf")


# ── AC 3 · declared-vs-measured divergence ──────────────────────────────────────────────────────


class TestFpsDivergence:
    def test_cam01_real_numbers_are_flagged(self) -> None:
        # Measured live today: cam01 declares 30 and delivers 15.4.
        divergence, flagged = signals.fps_divergence(30.0, 15.4)
        assert flagged is True
        assert divergence == pytest.approx(-0.4867, abs=0.001)

    def test_cam12_real_numbers_are_not_flagged(self) -> None:
        # Also measured live today: cam12 declares 20 and delivers 20. The estate does not
        # uniformly lie, and a flag that libelled this camera would be wrong in front of the jury.
        divergence, flagged = signals.fps_divergence(20.0, 20.0)
        assert flagged is False
        assert divergence == 0.0

    def test_a_camera_that_declared_nothing_cannot_be_caught_lying(self) -> None:
        # Every sandbox camera is in this state: the catalogue supplies only {id, name}.
        assert signals.fps_divergence(None, 15.4) == (None, False)

    def test_an_unmeasurable_camera_is_not_a_diverging_one(self) -> None:
        assert signals.fps_divergence(30.0, None) == (None, False)

    def test_small_drift_is_tolerated(self) -> None:
        _, flagged = signals.fps_divergence(25.0, 24.0)
        assert flagged is False


# ── AC 4 · PTS drift ────────────────────────────────────────────────────────────────────────────


def test_pts_drift_is_wall_minus_pts() -> None:
    # 30 s of content pulled in 12 s: 18 s "ahead", which on a VOD source means the network was
    # fast, not that the camera's clock is wrong.
    assert signals.pts_drift_ms(30.0, 12.0) == -18_000
    assert signals.pts_drift_ms(30.0, 30.0) == 0


# ── AC 4 · focus and light ──────────────────────────────────────────────────────────────────────


class TestFocusAndLight:
    def test_a_sharp_frame_scores_higher_than_a_blurred_one(self) -> None:
        rng = np.random.default_rng(1)
        sharp = rng.integers(0, 255, (480, 640, 3), dtype=np.uint8)
        import cv2

        blurred = cv2.GaussianBlur(sharp, (31, 31), 0)

        assert signals.blur_score([sharp]) > signals.blur_score([blurred])

    def test_centre_crop_ignores_the_edges_where_the_overlays_live(self) -> None:
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        frame[0:20, :] = 255  # a burned-in timestamp banner across the top
        cropped = signals.centre_crop(frame)
        assert cropped.shape[:2] == (240, 320)
        assert cropped.max() == 0

    def test_luma_mean_tracks_brightness(self) -> None:
        dark = np.full((100, 100, 3), 10, dtype=np.uint8)
        bright = np.full((100, 100, 3), 200, dtype=np.uint8)
        assert signals.luma_mean([dark]) < signals.luma_mean([bright])

    @pytest.mark.parametrize(
        "luma,blur,expected",
        [
            (10.0, 500.0, False),   # effectively black
            (250.0, 500.0, False),  # blown out by a headlight
            (95.0, 500.0, True),    # streetlit night on this estate — still usable
            (120.0, 10.0, False),   # bright but out of focus
            (120.0, 500.0, True),
        ],
    )
    def test_night_usable_is_about_readability_not_the_hour(
        self, luma: float, blur: float, expected: bool
    ) -> None:
        # The recording runs ~21:00-09:00, so a flag that fired on darkness would condemn most of
        # the estate for most of its footage.
        assert signals.night_usable(luma, blur) is expected


# ── AC 5 and AC 6 · tamper ──────────────────────────────────────────────────────────────────────


def _noise_frame(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, (240, 320, 3), dtype=np.uint8)


def _checkerboard(cell: int, shift: int, invert: bool = False) -> np.ndarray:
    """A high-contrast scene that drifts slowly — structured like a real one.

    Uncorrelated noise is the wrong model for a camera view: every frame differs from the last by
    ~50 grey levels, so a scene cut is indistinguishable from ordinary motion and a cut test built
    on it proves nothing. A checkerboard drifting a pixel at a time behaves the way a traffic scene
    does — plenty of edges, and only a little changes between consecutive frames.
    """
    ys, xs = np.mgrid[0:240, 0:320]
    # Drift along x only. Moving both axes shifts two sets of cell boundaries at once, which makes
    # ordinary "motion" nearly as large as the cut and leaves the test unable to tell them apart.
    pattern = (((xs + shift) // cell) + (ys // cell)) % 2
    if invert:
        pattern = 1 - pattern
    frame = (pattern * 255).astype(np.uint8)
    return np.repeat(frame[:, :, None], 3, axis=2)


class TestTamper:
    def test_a_covered_lens_scores_high(self) -> None:
        """AC 5. Identical, featureless frames: no motion, no edges."""
        black = [np.zeros((240, 320, 3), dtype=np.uint8) for _ in range(40)]
        measured = signals.tamper_score(black)

        assert measured is not None
        assert measured.flagged is True
        assert measured.score >= DEFAULTS.tamper_flag_min

    def test_a_frozen_but_detailed_frame_still_scores_high(self) -> None:
        """A replayed still image is tampering too — it has edges but no motion.

        This is why the composite averages its two components instead of requiring both: an
        edges-only test would pass a frozen frame as healthy.
        """
        frozen = [_noise_frame(7).copy() for _ in range(40)]
        measured = signals.tamper_score(frozen)
        assert measured is not None
        assert measured.median_frame_diff == 0.0
        assert measured.score > 0.4

    def test_a_working_camera_scores_low(self) -> None:
        """AC 5, the other half. A metric that flags everything is not a metric."""
        moving = [_noise_frame(i) for i in range(40)]
        measured = signals.tamper_score(moving)

        assert measured is not None
        assert measured.flagged is False
        assert measured.score < DEFAULTS.tamper_flag_min

    def test_the_loop_point_scene_cut_is_not_a_false_positive(self) -> None:
        """AC 6, the explicit test the ticket names.

        The feeds loop, so every long window contains one hard scene cut. Under a *mean*, that
        single enormous frame difference dominates and the statistic stops describing the scene.
        The medians here are unmoved by it — and `max_frame_diff` proves the cut was genuinely
        present and genuinely large, so this is not passing because the fixture was too gentle.
        """
        scene_a = [_checkerboard(cell=60, shift=i) for i in range(20)]
        scene_b = [_checkerboard(cell=45, shift=i, invert=True) for i in range(20)]
        measured = signals.tamper_score(scene_a + scene_b)

        assert measured is not None
        assert measured.flagged is False, "the loop point must not read as tamper"
        assert measured.max_frame_diff > measured.median_frame_diff * 5, (
            "the fixture must actually contain a large cut, or this test proves nothing — "
            f"median {measured.median_frame_diff}, max {measured.max_frame_diff}"
        )

    def test_too_few_frames_returns_none_rather_than_a_guess(self) -> None:
        assert signals.tamper_score([_noise_frame(1)]) is None
