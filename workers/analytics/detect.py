"""YOLO11 detection, narrowed to the vehicle classes the schema knows about.

`sightings.class` is the `vehicle_class` enum (`0002_enums.up.sql`). COCO has none of
`auto_rickshaw`, so the mapping is explicit and lossy in a stated direction: an auto-rickshaw is
detected by COCO as a car or a motorcycle and is recorded as whichever COCO said. D2-02 owns the
finer classification; inventing a class here would be a claim no model made.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .capabilities import CameraCapabilities, inference_size
from .device import Device
from .thresholds import DEFAULTS, AnalyticsThresholds

log = logging.getLogger("saakshi.analytics")

#: COCO id -> `vehicle_class`. Everything else is dropped before it reaches the tracker.
#:
#: `person` is kept because the enum has it and a pedestrian near a vehicle of interest is evidence;
#: `bicycle` likewise. No face recognition anywhere — we process no biometrics (CLAUDE.md).
COCO_TO_VEHICLE_CLASS: dict[int, str] = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
}

DEFAULT_MODEL = "models/yolo11n.pt"


@dataclass(frozen=True)
class Detection:
    """One box in one frame, before tracking."""

    x: float
    y: float
    w: float
    h: float
    confidence: float
    vehicle_class: str


@dataclass
class DetectorStats:
    calls: int = 0
    latencies_ms: list[float] = field(default_factory=list)

    def record(self, ms: float) -> None:
        self.calls += 1
        self.latencies_ms.append(ms)

    def percentile(self, p: float) -> float | None:
        if not self.latencies_ms:
            return None
        ordered = sorted(self.latencies_ms)
        idx = min(len(ordered) - 1, max(0, int(round((p / 100.0) * (len(ordered) - 1)))))
        return round(ordered[idx], 2)


class Detector:
    """A YOLO11 model shared across camera threads.

    Shared deliberately: eight copies of the weights on one MPS device is eight times the memory for
    the same arithmetic. ultralytics' `predict` is called under a lock so the shared model is not
    entered concurrently — the GPU serialises the work anyway, and an unlocked shared model produced
    non-deterministic garbage in testing.
    """

    def __init__(
        self,
        device: Device,
        weights: str | Path = DEFAULT_MODEL,
        thresholds: AnalyticsThresholds = DEFAULTS,
    ) -> None:
        from ultralytics import YOLO  # noqa: PLC0415 — heavy import, deferred so tests can stub

        import threading  # noqa: PLC0415

        self.device = device
        self.thresholds = thresholds
        self.weights = str(weights)
        self.stats = DetectorStats()
        self._lock = threading.Lock()
        # Model weights are gitignored (they are large binaries, and a weight file in git is one
        # nobody can audit or reproduce). A fresh clone that has not run `make models` falls back to
        # the bare name, which ultralytics resolves by downloading — better than a stack trace that
        # says only "file not found".
        if not Path(self.weights).exists():
            fallback = Path(self.weights).name
            log.warning(
                "%s not present — falling back to %r, which ultralytics will fetch. "
                "Run `make models` to keep it in the repo-local models/ directory.",
                self.weights, fallback,
            )
            self.weights = fallback
        self._model = YOLO(self.weights)
        log.info("detector: %s on %s", self.weights, device.description)

    def infer(self, frame: np.ndarray, capabilities: CameraCapabilities) -> list[Detection]:
        imgsz = inference_size(capabilities, self.thresholds)
        kwargs: dict[str, object] = {
            "imgsz": imgsz,
            "conf": self.thresholds.detect_confidence_min,
            "iou": self.thresholds.detect_iou,
            "device": self.device.name,
            "verbose": False,
        }
        # Passed only when it is actually wanted. ultralytics warns on every call that mentions
        # `half`, so passing `half=False` on MPS filled the run log with a deprecation notice about
        # a feature we were declining to use.
        if self.device.half_precision:
            kwargs["half"] = True
        started = time.perf_counter()
        with self._lock:
            results = self._model.predict(frame, **kwargs)
        self.stats.record((time.perf_counter() - started) * 1000.0)
        return _to_detections(results)


def _to_detections(results: object) -> list[Detection]:
    out: list[Detection] = []
    for result in results:  # type: ignore[attr-defined]
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for xyxy, conf, cls in zip(
            boxes.xyxy.tolist(), boxes.conf.tolist(), boxes.cls.tolist(), strict=True
        ):
            vehicle_class = COCO_TO_VEHICLE_CLASS.get(int(cls))
            if vehicle_class is None:
                continue
            x1, y1, x2, y2 = xyxy
            w, h = x2 - x1, y2 - y1
            if w <= 0 or h <= 0:
                continue
            out.append(
                Detection(
                    x=max(0.0, x1),
                    y=max(0.0, y1),
                    w=w,
                    h=h,
                    confidence=float(conf),
                    vehicle_class=vehicle_class,
                )
            )
    return out
