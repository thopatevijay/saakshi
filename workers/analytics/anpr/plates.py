"""Plate detection — an open-weights YOLO-v9 ONNX model, run on CPU on purpose.

**The CoreML execution provider is disabled, and that is a bug fix rather than a preference.** On
Apple Silicon `onnxruntime` selects CoreML by default for this graph, and CoreML then fails on every
frame that contains *no* plate:

    Input (/end2end/Add_1_output_0) has a dynamic shape ({-1}) but the runtime shape ({0})
    has zero elements. This is not supported by the CoreML EP.

`open-image-models` catches that and logs a warning, so the call returns an empty list and the run
looks like a quiet estate rather than a broken provider. Measured across the 120 D0-01 recon frames:
identical detections either way on the frames that *had* a plate, and a wall of errors on the 110
that did not. Pinning `CPUExecutionProvider` removes the noise and the ambiguity.

Weights and licence are recorded in `docs/model-licences.md`. Nothing here is proprietary.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

import numpy as np

from .thresholds import ANPR_DEFAULTS, AnprThresholds

log = logging.getLogger("saakshi.analytics.anpr")

Frame = np.ndarray

__all__ = ["PlateBox", "PlateDetector", "DEFAULT_PLATE_MODEL", "PLATE_PROVIDERS"]

#: `yolo-v9-s`, not `-t`: the small model is ~4x the tiny one's compute and finds plates the tiny one
#: misses at this estate's plate sizes, and plate detection is not the pipeline's bottleneck — 92%
#: of wall time is already spent blocked on the gateway (D1-09).
DEFAULT_PLATE_MODEL = "yolo-v9-s-608-license-plate-end2end"

#: See the module docstring. Pinned, never autodetected.
PLATE_PROVIDERS = ("CPUExecutionProvider",)


@dataclass(frozen=True)
class PlateBox:
    """A plate in the coordinate space of the image it was detected in."""

    x: float
    y: float
    w: float
    h: float
    confidence: float

    @property
    def area(self) -> float:
        return self.w * self.h


@dataclass
class PlateDetectorStats:
    calls: int = 0
    boxes: int = 0
    latencies_ms: list[float] = field(default_factory=list)

    def record(self, ms: float, boxes: int) -> None:
        self.calls += 1
        self.boxes += boxes
        self.latencies_ms.append(ms)

    def percentile(self, p: float) -> float | None:
        if not self.latencies_ms:
            return None
        ordered = sorted(self.latencies_ms)
        index = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
        return round(ordered[index], 2)


class PlateDetector:
    """One shared ONNX session across every camera thread.

    Shared for the same reason D1-09 shares the YOLO11 detector: eight copies of the weights is
    eight times the memory for the same arithmetic. `Run()` is serialised under a lock — the ORT
    session is nominally thread-safe, but this is the third model on the device and an unlocked
    shared session is not a place to discover otherwise during a 20-minute soak.
    """

    def __init__(
        self,
        model: str = DEFAULT_PLATE_MODEL,
        thresholds: AnprThresholds = ANPR_DEFAULTS,
    ) -> None:
        from open_image_models import create_detector  # noqa: PLC0415 — heavy, deferred

        self.model = model
        self.thresholds = thresholds
        self.stats = PlateDetectorStats()
        self._lock = threading.Lock()
        self._detector = create_detector(
            model, conf_thresh=thresholds.plate_conf_min, providers=list(PLATE_PROVIDERS)
        )
        log.info("plate detector: %s on %s", model, PLATE_PROVIDERS[0])

    def detect(self, image: Frame) -> list[PlateBox]:
        """Every plate in `image`, ordered largest first."""
        if image.size == 0 or image.shape[0] < 8 or image.shape[1] < 8:
            return []
        started = time.perf_counter()
        with self._lock:
            results = self._detector.predict(image)
        elapsed = (time.perf_counter() - started) * 1000.0

        boxes: list[PlateBox] = []
        for result in results:
            bounds = result.bounding_box
            width = float(bounds.x2 - bounds.x1)
            height = float(bounds.y2 - bounds.y1)
            if width <= 0 or height <= 0:
                continue
            boxes.append(
                PlateBox(
                    x=float(max(0.0, bounds.x1)),
                    y=float(max(0.0, bounds.y1)),
                    w=width,
                    h=height,
                    confidence=float(result.confidence),
                )
            )
        boxes.sort(key=lambda box: -box.area)
        self.stats.record(elapsed, len(boxes))
        return boxes
