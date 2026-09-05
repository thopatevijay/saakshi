"""Perspective correction of a plate crop before OCR.

A traffic camera almost never sees a plate square-on. The glyphs on an oblique plate are sheared
and unevenly scaled across the string, which is exactly the deformation a recogniser trained on
rectified plates has no invariance to — so the last characters read as something else, or the read
collapses entirely.

Three methods, tried in order, and **the one that was used is recorded on every read**:

1. `quad`     — the plate's own four corners found by contour approximation, warped to a canonical
                rectangle. The real fix.
2. `minarea`  — no clean quadrilateral, but a rotated bounding rectangle exists: deskew by its
                angle. Corrects roll but not perspective.
3. `resize`   — nothing found; scale to the canonical size. Recorded as *not rectified*, so a
                number produced this way is never quoted as evidence that rectification works.

Recording the method is the difference between "rectification implemented" and a claim that
happens to be true on the frames someone looked at.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

from .thresholds import ANPR_DEFAULTS, AnprThresholds

Frame = np.ndarray
RectifyMethod = Literal["quad", "minarea", "resize"]

__all__ = [
    "RectifyResult",
    "RectifyMethod",
    "APPROX_EPSILONS",
    "RECTIFY_MARGIN",
    "plate_quad",
    "rectify",
    "order_quad",
]

#: Contour-approximation tolerances, tried in order. See `plate_quad`.
APPROX_EPSILONS = (0.03, 0.05, 0.02, 0.08)

#: Border left around the plate in the rectified image, as a fraction of the output size.
#:
#: **Not cosmetic.** PP-OCR's detection stage is a segmentation model: a text region touching the
#: image edge has no background to segment against, and it returns *no box at all*. Measured — a
#: 120-px oblique crop warped edge-to-edge read as `<none>` and read correctly with this margin.
#: The fixed-slot recogniser is indifferent to it, so the margin costs nothing and fixes one engine.
RECTIFY_MARGIN = 0.08


@dataclass(frozen=True)
class RectifyResult:
    image: Frame
    method: RectifyMethod
    #: The four source corners, top-left / top-right / bottom-right / bottom-left. `None` unless
    #: `method == "quad"`.
    quad: np.ndarray | None = None
    #: Roll removed, in degrees. Only meaningful for `minarea`.
    angle_deg: float = 0.0


def order_quad(points: np.ndarray) -> np.ndarray:
    """Orders four points as top-left, top-right, bottom-right, bottom-left.

    `getPerspectiveTransform` maps corner *i* to corner *i*, so an unordered quad produces a warp
    that is geometrically valid and reads the plate upside down or mirrored. Ordering by the sum and
    difference of the coordinates is the standard trick and is exact for any convex quadrilateral
    that is not rotated past 45 degrees — which a plate on a road never is.
    """
    pts = np.asarray(points, dtype=np.float32).reshape(4, 2)
    total = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).ravel()
    return np.array(
        [
            pts[int(np.argmin(total))],  # top-left  — smallest x+y
            pts[int(np.argmin(diff))],  # top-right — smallest y-x
            pts[int(np.argmax(total))],  # bottom-right
            pts[int(np.argmax(diff))],  # bottom-left
        ],
        dtype=np.float32,
    )


def plate_quad(
    crop: Frame, thresholds: AnprThresholds = ANPR_DEFAULTS
) -> tuple[np.ndarray | None, float]:
    """Finds the plate's four corners inside a padded crop. Returns `(quad, area_ratio)`.

    The plate is the *bright rectangle with dark glyphs* in a crop that was already centred on it by
    the detector, so the search is deliberately simple: threshold, take contours, keep the largest
    one that approximates to four points and is convex.

    `cv2.THRESH_OTSU` rather than a fixed level — a plate at night under sodium light and one at
    noon share no absolute brightness, and a fixed threshold turns the night case into a blank mask.
    """
    if crop.size == 0 or crop.shape[0] < 8 or crop.shape[1] < 8:
        return None, 0.0
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    # Blur before Otsu: at 16 px tall, single-pixel glyph noise is a large fraction of the histogram
    # and drags the automatic threshold onto the characters instead of onto the plate boundary.
    blurred = cv2.GaussianBlur(grey, (3, 3), 0)
    _, mask = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, 0.0

    crop_area = float(crop.shape[0] * crop.shape[1])
    best: np.ndarray | None = None
    best_area = 0.0
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area <= best_area:
            continue
        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            continue
        # Several epsilons rather than one. A plate seen at a grazing angle has a longer perimeter
        # for the same area, so a single fixed epsilon that finds four corners head-on returns five
        # or six on exactly the oblique plates rectification exists for — and the code would then
        # fall back to a plain resize precisely where it matters most. Measured: at a 0.42 shift the
        # single-epsilon version fell back to `resize` on every crop.
        for epsilon in APPROX_EPSILONS:
            approx = cv2.approxPolyDP(contour, epsilon * perimeter, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                best, best_area = approx, area
                break

    if best is None or crop_area <= 0:
        return None, 0.0
    ratio = best_area / crop_area
    if ratio < thresholds.quad_min_area_ratio:
        # A four-sided highlight on a bumper. Warping to it is worse than not warping at all.
        return None, ratio
    ordered = order_quad(best)
    if _spans_the_whole_crop(ordered, crop.shape[1], crop.shape[0]):
        # The *crop's* own boundary, not the plate's. Otsu on a uniform or low-contrast crop
        # thresholds the entire rectangle, and the resulting "quad" is the four image corners:
        # warping to it is an identity transform wearing the `quad` label, which would let a plain
        # resize be reported as a successful rectification.
        #
        # Tested geometrically rather than by area ratio, because `findContours` insets by a pixel
        # and one pixel is 6% of a 16-px-tall crop but 0.6% of a 160-px one — an area threshold that
        # catches the small case waves the large one through.
        return None, ratio
    return ordered, ratio


def _spans_the_whole_crop(quad: np.ndarray, width: int, height: int, slack: int = 3) -> bool:
    return bool(
        (quad[:, 0].max() - quad[:, 0].min()) >= width - slack
        and (quad[:, 1].max() - quad[:, 1].min()) >= height - slack
    )


def rectify(crop: Frame, thresholds: AnprThresholds = ANPR_DEFAULTS) -> RectifyResult:
    """Perspective-corrects a plate crop to the canonical `rectify_width x rectify_height`."""
    width, height = thresholds.rectify_width, thresholds.rectify_height
    if crop.size == 0:
        return RectifyResult(image=crop, method="resize")

    quad, _ratio = plate_quad(crop, thresholds)
    if quad is not None:
        inset_x = width * RECTIFY_MARGIN
        inset_y = height * RECTIFY_MARGIN
        destination = np.array(
            [
                [inset_x, inset_y],
                [width - 1 - inset_x, inset_y],
                [width - 1 - inset_x, height - 1 - inset_y],
                [inset_x, height - 1 - inset_y],
            ],
            dtype=np.float32,
        )
        transform = cv2.getPerspectiveTransform(quad, destination)
        warped = cv2.warpPerspective(
            crop, transform, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
        )
        return RectifyResult(image=warped, method="quad", quad=quad)

    angle = _minarea_angle(crop)
    if angle is not None and abs(angle) > 1.0:
        rotated = _rotate(crop, angle)
        resized = cv2.resize(rotated, (width, height), interpolation=cv2.INTER_CUBIC)
        return RectifyResult(image=resized, method="minarea", angle_deg=angle)

    return RectifyResult(
        image=cv2.resize(crop, (width, height), interpolation=cv2.INTER_CUBIC), method="resize"
    )


def _minarea_angle(crop: Frame) -> float | None:
    """Roll angle of the largest dark-on-light blob, in degrees, or `None`."""
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    _, mask = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < 0.1 * crop.shape[0] * crop.shape[1]:
        return None
    (_cx, _cy), (w, h), angle = cv2.minAreaRect(largest)
    if w < h:
        # OpenCV reports the angle of the *first* edge; for a portrait rectangle that edge is the
        # short one, and using it unadjusted deskews a plate by 90 degrees.
        angle += 90.0
    if angle > 45.0:
        angle -= 90.0
    if angle < -45.0:
        angle += 90.0
    return float(angle)


def _rotate(image: Frame, angle_deg: float) -> Frame:
    h, w = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle_deg, 1.0)
    return cv2.warpAffine(
        image, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
