"""The motion gate and the loop-point scene-cut detector.

Both are pure functions over frames plus a small explicit state object, which is what makes ACs 3
and 7 falsifiable offline instead of only against a live camera.

The two look similar and are not the same question:

- the **gate** asks "has anything changed since the last frame we *inferred*" — a saving;
- the **cut detector** asks "is this frame from a different scene entirely" — an identity boundary.

A gate comparing against the previous frame would skip a vehicle that crosses the frame in
imperceptible steps. A cut detector comparing against the last inferred frame would call every
skipped stretch a cut. Hence two references, deliberately.
"""

from __future__ import annotations

import statistics
from collections import deque
from dataclasses import dataclass, field

import cv2
import numpy as np

from .thresholds import DEFAULTS, AnalyticsThresholds

Frame = np.ndarray


def thumbnail(frame: Frame, width: int = DEFAULTS.motion_grey_width) -> Frame:
    """Greyscale, downscaled. The comparison surface for both detectors.

    Downscaling first is not only cheap, it is *more* correct: at full resolution sensor noise and
    JPEG-ish compression shimmer dominate the difference on a genuinely static scene.
    """
    if frame.ndim == 3:
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    else:
        grey = frame
    h, w = grey.shape[:2]
    if w <= width:
        return grey
    scale = width / float(w)
    return cv2.resize(grey, (width, max(1, int(round(h * scale)))), interpolation=cv2.INTER_AREA)


def mean_abs_diff(a: Frame, b: Frame) -> float:
    """Mean absolute 0-255 difference between two thumbnails.

    Returns `inf` when the shapes differ, which is the honest answer: a resolution change mid-stream
    *is* a scene discontinuity, and silently resizing one to match the other would hide it.
    """
    if a.shape != b.shape:
        return float("inf")
    return float(np.mean(cv2.absdiff(a, b)))


@dataclass
class MotionGate:
    """Skip inference on frames that have not changed since the last frame we inferred.

    `frames_considered / inferences_run` is the skip ratio the AC asks to be logged. Both counters
    live here rather than in the pipeline so the ratio is measured at the point of the decision.
    """

    thresholds: AnalyticsThresholds = DEFAULTS
    _reference: Frame | None = field(default=None, repr=False)
    _last_infer_pts_s: float | None = field(default=None, repr=False)
    frames_considered: int = 0
    inferences_run: int = 0
    #: Inferences forced by the keep-alive rather than by motion. A stopped vehicle is still tracked.
    keepalive_inferences: int = 0
    last_diff: float | None = None

    def should_infer(self, thumb: Frame, pts_s: float) -> bool:
        """True when this frame must go to the detector."""
        self.frames_considered += 1

        if self._reference is None:
            self._accept(thumb, pts_s)
            return True

        diff = mean_abs_diff(self._reference, thumb)
        self.last_diff = diff

        if diff >= self.thresholds.motion_diff_min:
            self._accept(thumb, pts_s)
            return True

        # No motion — but a vehicle stopped at a signal produces no motion either, and letting its
        # track age out would make it a new identity when it moves off.
        stale = (
            self._last_infer_pts_s is None
            or (pts_s - self._last_infer_pts_s) >= self.thresholds.motion_keepalive_pts_s
        )
        if stale:
            self.keepalive_inferences += 1
            self._accept(thumb, pts_s)
            return True

        return False

    def _accept(self, thumb: Frame, pts_s: float) -> None:
        self._reference = thumb
        self._last_infer_pts_s = pts_s
        self.inferences_run += 1

    def reset(self) -> None:
        """Called on a scene cut and on every reconnect: the old reference is a different scene."""
        self._reference = None
        self._last_infer_pts_s = None

    @property
    def skip_ratio(self) -> float:
        """Fraction of considered frames that never reached the detector."""
        if self.frames_considered == 0:
            return 0.0
        return 1.0 - (self.inferences_run / self.frames_considered)


@dataclass
class SceneCutDetector:
    """Detects the hard cut a looping feed produces once per cycle.

    Two conditions, both required:

    1. the difference clears an **absolute floor** — a cut is a big number, not merely a relative one;
    2. it is a **multiple of the rolling median** of recent differences — so a camera that is busy
       all the time does not have every truck classed as a cut.

    Median rather than mean is D1-05's finding: the mean of a window containing the cut is dragged
    up by the cut itself, so a mean-based detector is quietest exactly where it must be loudest.
    """

    thresholds: AnalyticsThresholds = DEFAULTS
    _previous: Frame | None = field(default=None, repr=False)
    _history: deque[float] = field(default_factory=lambda: deque(maxlen=DEFAULTS.scene_cut_history), repr=False)
    cuts: int = 0
    last_diff: float | None = None
    last_median: float | None = None

    def __post_init__(self) -> None:
        if self._history.maxlen != self.thresholds.scene_cut_history:
            self._history = deque(self._history, maxlen=self.thresholds.scene_cut_history)

    def update(self, thumb: Frame) -> bool:
        """Feed one thumbnail. True when this frame begins a new scene."""
        previous, self._previous = self._previous, thumb
        if previous is None:
            return False

        diff = mean_abs_diff(previous, thumb)
        self.last_diff = diff

        # A resolution change is a discontinuity by definition; there is no meaningful ratio to take.
        if diff == float("inf"):
            self._history.clear()
            self.cuts += 1
            return True

        median = statistics.median(self._history) if self._history else None
        self.last_median = median

        is_cut = diff >= self.thresholds.scene_cut_diff_min
        if is_cut and len(self._history) >= self.thresholds.scene_cut_min_history:
            # Floor the divisor. A median of exactly 0 on a perfectly static feed would otherwise
            # divide by zero — the same class of bug as D1-03's PTS delta of 0.0.
            floor = max(float(median or 0.0), self.thresholds.min_pts_delta_s)
            is_cut = (diff / floor) >= self.thresholds.scene_cut_median_ratio

        if is_cut:
            # The cut itself must not enter the median, or the next frame's baseline is the cut.
            self._history.clear()
            self.cuts += 1
            return True

        self._history.append(diff)
        return False

    def reset(self) -> None:
        self._previous = None
        self._history.clear()
