"""Rectification — AC 2.

The acceptance criterion is *"a test with a deliberately oblique plate shows improved read"*, so the
headline test does exactly that: render a known plate, project it as a camera at an angle would,
then read it with and without rectification through a **real OCR backend** and compare.

That test needs a model, so it is marked and skipped when the weights are not present. The geometry
tests below need nothing and always run — they are what make a rectification failure diagnosable
rather than merely visible in a dropped accuracy number.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from workers.analytics.anpr.ocr import create_ocr_backend
from workers.analytics.anpr.rectify import order_quad, plate_quad, rectify
from workers.analytics.anpr.thresholds import ANPR_DEFAULTS

from .conftest import draw_plate, oblique, oblique_crop


def edit_distance(a: str, b: str) -> int:
    """Levenshtein. Small enough to write; a dependency for it would be silly."""
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb))
            )
        previous = current
    return previous[-1]


def test_order_quad_puts_the_corners_in_warp_order() -> None:
    """`getPerspectiveTransform` maps corner i to corner i — unordered input reads the plate mirrored."""
    scrambled = np.array([[90, 40], [10, 40], [95, 5], [5, 8]], dtype=np.float32)
    ordered = order_quad(scrambled)

    top_left, top_right, bottom_right, bottom_left = ordered
    assert top_left[0] < top_right[0]
    assert top_left[1] < bottom_left[1]
    assert bottom_right[0] > bottom_left[0]
    assert bottom_right[1] > top_right[1]


def test_plate_quad_finds_the_plate_boundary_in_a_padded_crop(plate_text: str) -> None:
    canvas = np.full((80, 240, 3), 70, np.uint8)
    canvas[16:64, 24:216] = draw_plate(plate_text, width=192, height=48)

    quad, ratio = plate_quad(canvas, ANPR_DEFAULTS)

    assert quad is not None
    assert ratio > ANPR_DEFAULTS.quad_min_area_ratio
    # The found quad must actually be the plate, not the whole crop.
    assert quad[:, 0].min() >= 12
    assert quad[:, 0].max() <= 228


def test_plate_quad_refuses_a_small_four_sided_highlight() -> None:
    """A bumper reflection is a convex quadrilateral too. Warping to it is worse than not warping."""
    canvas = np.full((80, 240, 3), 40, np.uint8)
    cv2.rectangle(canvas, (100, 34), (128, 46), (230, 230, 230), -1)

    quad, ratio = plate_quad(canvas, ANPR_DEFAULTS)

    assert quad is None
    assert ratio < ANPR_DEFAULTS.quad_min_area_ratio


def test_rectify_always_returns_the_canonical_geometry(plate_text: str) -> None:
    """Whatever method fires, the OCR must never also be asked to undo a projection."""
    for image in (
        draw_plate(plate_text),
        oblique(draw_plate(plate_text)),
        np.full((11, 29, 3), 128, np.uint8),
    ):
        result = rectify(image, ANPR_DEFAULTS)
        assert result.image.shape[:2] == (ANPR_DEFAULTS.rectify_height, ANPR_DEFAULTS.rectify_width)
        assert result.method in {"quad", "minarea", "resize"}


def test_rectify_records_the_method_it_used(plate_text: str) -> None:
    """A number produced by a plain resize must never be quoted as evidence rectification works."""
    quad_case = rectify(oblique(draw_plate(plate_text)), ANPR_DEFAULTS)
    flat_case = rectify(np.full((16, 48, 3), 128, np.uint8), ANPR_DEFAULTS)

    assert quad_case.method == "quad"
    assert quad_case.quad is not None
    assert flat_case.method == "resize"


@pytest.mark.parametrize("shift_ratio", [0.30, 0.42, 0.52])
def test_rectifying_a_deliberately_oblique_plate_improves_the_read(
    shift_ratio: float, plate_text: str
) -> None:
    """AC 2, end to end, through a real recogniser, at three degrees of obliqueness.

    Read with `fast_plate_ocr` deliberately. It is a fixed-slot recogniser with no internal
    rectification, so what it reads is what geometry hands it — which makes it the honest instrument
    for measuring what rectification is worth. PP-OCR performs its own text-region rectification
    inside the detector, so measuring rectification through it would mostly measure PP-OCR (see
    `docs/anpr-accuracy.md`; the same comparison run through PP-OCR is recorded there).

    Edit distance rather than exact match on both sides: an oblique plate does not fail cleanly, it
    fails by a character or three, and "improved" has to mean *measurably closer* or the criterion
    could be satisfied by two different kinds of wrong.
    """
    backend = create_ocr_backend("fast_plate_ocr")
    skewed = oblique_crop(plate_text, shift_ratio=shift_ratio, out_width=160)

    unrectified = cv2.resize(
        skewed, (ANPR_DEFAULTS.rectify_width, ANPR_DEFAULTS.rectify_height),
        interpolation=cv2.INTER_CUBIC,
    )
    rectified = rectify(skewed, ANPR_DEFAULTS)
    assert rectified.method == "quad", "the fixture must exercise the perspective path"

    before = backend.read(unrectified)
    after = backend.read(rectified.image)

    before_distance = edit_distance(before.text if before else "", plate_text)
    after_distance = edit_distance(after.text if after else "", plate_text)

    assert after_distance < before_distance, (
        f"rectification did not improve the read: "
        f"{before.text if before else '<none>'} (d={before_distance}) -> "
        f"{after.text if after else '<none>'} (d={after_distance})"
    )
    # Not merely closer — correct. The unrectified read at these angles is unrecognisable garbage.
    assert after is not None and after.text == plate_text
