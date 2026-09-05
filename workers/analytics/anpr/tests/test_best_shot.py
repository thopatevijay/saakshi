"""Best-shot scoring and the top-N buffer — the selection half of AC 1.

The accuracy half (best-shot vs every-frame on a recorded segment) is measured by
`workers.analytics.eval_anpr --compare`, because it needs real footage. These tests prove the
mechanism does what the score claims: prefers sharp over blurred, large over small, square-on over
grazing, and keeps only the best N.
"""

from __future__ import annotations

import cv2
import numpy as np

from workers.analytics.anpr.best_shot import (
    STALE_AFTER,
    BestShotBuffer,
    PlateCandidate,
    area_score,
    best_shot_score,
    frontality,
    sharpness,
)
from workers.analytics.anpr.thresholds import ANPR_DEFAULTS


def candidate(score: float, crop: np.ndarray | None = None) -> PlateCandidate:
    return PlateCandidate(
        score=score,
        crop=crop if crop is not None else np.zeros((16, 48, 3), np.uint8),
        plate_width=48.0,
        plate_height=16.0,
        detect_confidence=0.8,
        frame_pts_ms=1000,
        ts="2026-09-05T00:00:00Z",
    )


def test_sharpness_prefers_the_focused_plate(sharp_plate, blurred_plate) -> None:
    assert sharpness(sharp_plate) > sharpness(blurred_plate) * 2


def test_sharpness_is_measured_on_the_plate_not_the_scene(sharp_plate) -> None:
    """A blurred plate on a sharp background must score low.

    The failure this rules out is the common one: scoring the frame instead of the crop, which
    reliably selects the frame where the *road markings* are crispest.
    """
    blurred_plate_only = cv2.GaussianBlur(sharp_plate, (9, 9), 0)
    noisy_background = np.random.default_rng(7).integers(
        0, 255, (160, 320, 3), dtype=np.uint8
    )
    noisy_background[56:104, 64:256] = blurred_plate_only
    assert sharpness(blurred_plate_only) < sharpness(noisy_background)


def test_frontality_peaks_at_the_indian_single_row_ratio() -> None:
    head_on = frontality(417.0, 100.0)
    oblique_view = frontality(200.0, 100.0)
    grazing = frontality(900.0, 100.0)

    assert head_on > 0.99
    assert oblique_view < head_on
    assert grazing < head_on


def test_frontality_does_not_delete_a_two_row_motorcycle_plate() -> None:
    """1.43:1 is the legal two-row plate, not an error. It must score above zero.

    A hard aspect gate here would silently remove the two-wheeler class — the class the accuracy
    report is specifically obliged to be honest about.
    """
    assert frontality(285.0, 200.0) > 0.3


def test_area_score_saturates_rather_than_growing_without_bound() -> None:
    """One close-up frame must not win on size alone while being unreadable.

    Saturation is asserted where it matters — above the size at which a plate is already legible.
    Each doubling past `readable` must buy strictly less than the one before, and the score must
    stay bounded by 1, so a plate ten times the size of a readable one cannot outscore it by ten
    times and drag a motion-blurred frame to the top of the buffer.
    """
    small = area_score(24, 8)
    readable = area_score(48, 16)
    doubled = area_score(96, 32)
    quadrupled = area_score(192, 64)
    huge = area_score(400, 120)

    assert small < readable < doubled < quadrupled <= huge <= 1.0
    assert quadrupled - doubled < doubled - readable


def test_best_shot_score_ranks_the_sharp_plate_above_the_blurred_one(
    sharp_plate, blurred_plate
) -> None:
    sharp = best_shot_score(192, 48, sharp_plate, ANPR_DEFAULTS)
    blurred = best_shot_score(192, 48, blurred_plate, ANPR_DEFAULTS)

    assert sharp > blurred


def test_buffer_keeps_only_the_best_n() -> None:
    buffer = BestShotBuffer(top_n=3)
    for score in (0.1, 0.9, 0.4, 0.7, 0.2):
        buffer.offer(candidate(score))

    assert [round(c.score, 1) for c in buffer.candidates] == [0.9, 0.7, 0.4]
    assert buffer.best is not None
    assert buffer.best.score == 0.9


def test_buffer_is_ready_when_full() -> None:
    buffer = BestShotBuffer(top_n=3)
    buffer.offer(candidate(0.5))
    assert not buffer.ready()
    buffer.offer(candidate(0.6))
    buffer.offer(candidate(0.7))
    assert buffer.ready()


def test_buffer_is_ready_when_the_examination_budget_is_spent() -> None:
    buffer = BestShotBuffer(top_n=3)
    buffer.examined = ANPR_DEFAULTS.max_examine_per_track
    assert buffer.ready(ANPR_DEFAULTS.max_examine_per_track)


def test_a_vehicle_that_shows_its_plate_once_then_turns_away_still_votes() -> None:
    """The stale clause. Without it this track's only read is lost at the end of the run."""
    buffer = BestShotBuffer(top_n=3)
    buffer.offer(candidate(0.6))
    for _ in range(STALE_AFTER):
        buffer.examined += 1
        buffer.stale += 1

    assert buffer.ready()


def test_an_empty_buffer_never_votes_however_long_it_waits() -> None:
    """Nothing seen is nothing to say. A vote on no candidates would be an invented vehicle."""
    buffer = BestShotBuffer(top_n=3)
    buffer.examined = 3
    buffer.stale = 99
    assert not buffer.ready(max_examine=99)
