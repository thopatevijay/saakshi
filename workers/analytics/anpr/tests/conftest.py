"""Synthetic plates, drawn rather than committed.

A committed JPEG is a fixture nobody can regenerate or audit; a drawn one states its own ground
truth in the code that makes it. Every plate here is rendered from a known string, so a test that
asserts an OCR read is comparing against something the test itself defined.

The plates are drawn at the scale this estate actually delivers — the real readable plates measured
36x15 and 48x16 pixels on `cam06` and `cam21` — rather than at a scale that would make any OCR look
good.
"""

from __future__ import annotations

import cv2
import numpy as np
import pytest


def draw_plate(
    text: str,
    *,
    width: int = 192,
    height: int = 48,
    background: int = 235,
    foreground: int = 20,
) -> np.ndarray:
    """A white plate with dark glyphs, the Indian single-row layout, as a BGR image."""
    image = np.full((height, width, 3), background, dtype=np.uint8)
    cv2.rectangle(image, (1, 1), (width - 2, height - 2), (foreground,) * 3, 1)
    scale = (width / 192.0) * 0.95
    thickness = max(1, int(round(scale * 2)))
    (text_w, text_h), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
    origin = ((width - text_w) // 2, (height + text_h) // 2)
    cv2.putText(
        image, text, origin, cv2.FONT_HERSHEY_SIMPLEX, scale, (foreground,) * 3,
        thickness, cv2.LINE_AA,
    )
    return image


def oblique(image: np.ndarray, shift_ratio: float = 0.35) -> np.ndarray:
    """Projects a plate as if seen from the side, keeping the frame size.

    The deformation a traffic camera actually applies: the far edge is shorter than the near one, so
    the glyphs are unevenly compressed across the string rather than uniformly scaled. A uniform
    squash would be a much easier problem than the real one.
    """
    h, w = image.shape[:2]
    shift = w * shift_ratio
    source = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    destination = np.float32(
        [[shift, h * 0.18], [w - 1, 0], [w - 1, h - 1], [shift, h * 0.82]]
    )
    matrix = cv2.getPerspectiveTransform(source, destination)
    return cv2.warpPerspective(
        image, matrix, (w, h), flags=cv2.INTER_CUBIC, borderValue=(60, 60, 60)
    )


def oblique_crop(text: str, *, shift_ratio: float, out_width: int, pad: float = 0.18) -> np.ndarray:
    """An oblique plate crop the way a camera makes one: **render big, project, then sample down.**

    The order matters and is not a detail. Drawing at 48 px tall and *then* warping destroys the
    glyph detail before the projection has a chance to deform it, which produces a fixture that is
    mostly a resampling artefact — easier for some engines and harder for others in ways that have
    nothing to do with perspective. Projecting a 768 px plate and sampling the result down to the
    estate's real crop widths reproduces what the sensor does.

    `pad` leaves the surround the plate detector's own padding would leave, so the contour finder
    has a boundary to find.
    """
    big_w, big_h = 768, 192
    plate = draw_plate(text, width=big_w, height=big_h)
    pad_x, pad_y = int(big_w * pad), int(big_h * pad)
    canvas = np.full((big_h + 2 * pad_y, big_w + 2 * pad_x, 3), 75, dtype=np.uint8)
    canvas[pad_y : pad_y + big_h, pad_x : pad_x + big_w] = plate

    h, w = canvas.shape[:2]
    source = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    destination = np.float32(
        [[w * shift_ratio, h * 0.16], [w - 1, 0], [w - 1, h - 1], [w * shift_ratio, h * 0.84]]
    )
    warped = cv2.warpPerspective(
        canvas,
        cv2.getPerspectiveTransform(source, destination),
        (w, h),
        flags=cv2.INTER_AREA,
        borderValue=(75, 75, 75),
    )
    out_height = int(round(out_width * h / w))
    return cv2.resize(warped, (out_width, out_height), interpolation=cv2.INTER_AREA)


def on_canvas(plate: np.ndarray, canvas_size: tuple[int, int] = (160, 320)) -> np.ndarray:
    """Places a plate on a mid-grey vehicle-ish background, centred."""
    canvas = np.full((canvas_size[0], canvas_size[1], 3), 90, dtype=np.uint8)
    ph, pw = plate.shape[:2]
    y = (canvas_size[0] - ph) // 2
    x = (canvas_size[1] - pw) // 2
    canvas[y : y + ph, x : x + pw] = plate
    return canvas


@pytest.fixture(scope="session")
def plate_text() -> str:
    """A valid Gujarat registration, in the format this estate would actually carry."""
    return "GJ01AB1234"


@pytest.fixture(scope="session")
def sharp_plate(plate_text: str) -> np.ndarray:
    return draw_plate(plate_text)


@pytest.fixture(scope="session")
def blurred_plate(plate_text: str) -> np.ndarray:
    """The same plate, motion-blurred. Best-shot selection must prefer the sharp one."""
    return cv2.GaussianBlur(draw_plate(plate_text), (9, 9), 0)


@pytest.fixture(scope="session")
def oblique_plate(plate_text: str) -> np.ndarray:
    return oblique(draw_plate(plate_text))
