"""Best-shot selection — which frames of a vehicle track are worth OCRing.

The ticket states the score directly: **plate bbox area x sharpness x frontality**. The three
factors are each normalised into `(0, 1]` before multiplying, for a reason worth writing down: a
Laplacian variance runs to the thousands while an area ratio is a fraction, so an unnormalised
product is a sharpness score wearing an area score as decoration. Normalised, the product means
what it says — a frame scores well only when it is *large and sharp and square-on*, which is
exactly the frame a human would pick.

Why this beats OCRing every frame, in one sentence: the extra frames are the blurred, oblique and
half-occluded ones, so every-frame OCR does more work **and** hands the vote more bad reads than
good ones. AC 1 measures both halves of that claim rather than asserting it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .thresholds import ANPR_DEFAULTS, AnprThresholds

Frame = np.ndarray

__all__ = [
    "PlateCandidate",
    "BestShotBuffer",
    "STALE_AFTER",
    "best_shot_score",
    "sharpness",
    "frontality",
    "area_score",
]

#: Examined frames without a new plate candidate after which a partly-filled buffer votes anyway.
#:
#: At the gateway's measured ~4 effective fps this is a full second of that vehicle being tracked
#: with no readable plate — it has turned, or it is behind something. Waiting longer trades a read
#: we already have for one that is not coming.
STALE_AFTER = 4


def sharpness(plate_crop: Frame) -> float:
    """Laplacian variance on the plate crop — the classical focus measure.

    On the **plate crop**, never the frame: a frame is sharp when the road markings are sharp, and
    the road markings are not what has to be read. A motion-blurred plate on a pin-sharp background
    is the single most common failure this rejects.
    """
    if plate_crop.size == 0:
        return 0.0
    grey = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2GRAY) if plate_crop.ndim == 3 else plate_crop
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def frontality(width: float, height: float, thresholds: AnprThresholds = ANPR_DEFAULTS) -> float:
    """How close the box's aspect is to a plate seen square-on. `1.0` is head-on.

    Scored as a *ratio distance* rather than a linear one, so a plate at 2:1 (badly oblique, or a
    two-row motorcycle plate) and one at 8:1 (extreme grazing angle) are penalised symmetrically —
    they are equally far from 4.17:1 in the only sense that matters, which is how much the glyphs
    are squeezed.

    Never a filter. A two-row plate legitimately sits near 1.43 and would be deleted by a hard
    aspect gate, taking with it the two-wheeler class the accuracy report is obliged to be honest
    about.
    """
    if width <= 0 or height <= 0:
        return 0.0
    aspect = width / height
    target = thresholds.plate_aspect_single_row
    ratio = min(aspect, target) / max(aspect, target)
    return float(ratio)


def area_score(plate_width: float, plate_height: float, reference_px: float = 64.0 * 16.0) -> float:
    """Plate area, saturating at a size beyond which more pixels stop buying accuracy.

    `reference_px` is 64x16 = 1024 px^2. Measured on this estate: a 48x16 plate (`cam21`) read
    correctly and a 36x15 plate (`cam06`) read correctly bar one character, so a 64x16 reference
    puts the estate's *best* real plates near — but not at — saturation, and leaves the score with
    room to distinguish them. A linear-in-area score would let one close-up frame dominate a track
    entirely on size while being motion-blurred.
    """
    if plate_width <= 0 or plate_height <= 0:
        return 0.0
    return float(1.0 - math.exp(-(plate_width * plate_height) / reference_px))


def best_shot_score(
    plate_width: float,
    plate_height: float,
    plate_crop: Frame,
    thresholds: AnprThresholds = ANPR_DEFAULTS,
) -> float:
    """`area x sharpness x frontality`, each in `(0, 1]`, as the ticket specifies.

    Sharpness is squashed through `1 - exp(-var/100)`: Laplacian variance is unbounded and
    scene-dependent, and 100 is the knee measured by D1-05's blur signal on this estate
    (`workers/prober/thresholds.py` treats ~130 as a sharp traffic frame).
    """
    sharp = sharpness(plate_crop)
    sharp_score = 1.0 - math.exp(-sharp / 100.0)
    return (
        area_score(plate_width, plate_height)
        * sharp_score
        * frontality(plate_width, plate_height, thresholds)
    )


@dataclass(frozen=True)
class PlateCandidate:
    """One frame's worth of plate evidence for one track."""

    score: float
    #: The padded plate crop, BGR, in the source frame's own pixels. Never rectified — rectification
    #: happens once, at OCR time, so the stored evidence is what the camera saw.
    crop: Frame
    plate_width: float
    plate_height: float
    detect_confidence: float
    frame_pts_ms: int
    #: Absolute wall time of the frame this came from, ISO 8601 with `Z`. Derived from PTS upstream.
    ts: str
    sharpness_var: float = 0.0
    #: The plate box's top-left in the **frame's** coordinates, not the vehicle crop's (D2-11).
    #: A bbox that only makes sense relative to a temporary crop is a bbox nobody downstream can
    #: use, and the evidence record that carries this crop to the object store is downstream.
    frame_x: float = 0.0
    frame_y: float = 0.0
    #: The tracked vehicle's class, carried so the evidence record can state what was cropped
    #: without the engine having to hold the tracker's item alongside the buffer.
    vehicle_class: str = "car"


@dataclass
class BestShotBuffer:
    """The top-N candidates seen so far for one track, plus how many frames were examined.

    A list rather than a heap: N is 3. A heap here would be a data-structure flourish costing more
    lines than the linear scan it replaces.
    """

    top_n: int = ANPR_DEFAULTS.best_shot_top_n
    candidates: list[PlateCandidate] = field(default_factory=list)
    examined: int = 0
    #: Frames examined since the last candidate was accepted. See `ready`.
    stale: int = 0
    #: Set once the vote has been emitted. One `plate_reads` row per track, per the ticket.
    emitted: bool = False

    def offer(self, candidate: PlateCandidate) -> bool:
        """Keeps `candidate` if it is among the best `top_n`. Returns whether it was kept."""
        self.stale = 0
        self.candidates.append(candidate)
        self.candidates.sort(key=lambda c: -c.score)
        if len(self.candidates) > self.top_n:
            dropped = self.candidates.pop()
            return dropped is not candidate
        return True

    @property
    def best(self) -> PlateCandidate | None:
        return self.candidates[0] if self.candidates else None

    def ready(
        self,
        max_examine: int = ANPR_DEFAULTS.max_examine_per_track,
        stale_after: int = STALE_AFTER,
    ) -> bool:
        """Enough evidence to vote.

        Three ways, and the third is the one that took thinking about:

        1. the buffer is full — the normal case;
        2. the examination budget is spent — bounds a vehicle parked in view;
        3. **there is at least one candidate and the plate has not been seen for `stale_after`
           examined frames.** Without this a vehicle that shows its plate twice and then turns away
           never reaches either of the first two conditions, and its read is lost at the end of the
           run. One good read with `vote_count = 1` is a real, honestly-labelled result; no read at
           all is a vehicle the system pretends it never saw.
        """
        if len(self.candidates) >= self.top_n or self.examined >= max_examine:
            return True
        return bool(self.candidates) and self.stale >= stale_after
