"""Per-camera capabilities, and the inference shape derived from them.

Failure mode 7 in `PROJECT.md §4` is "mixed H.264/H.265 and mixed resolutions — per-camera decoder +
batch shape, no fixed-shape inference batch". D0-01 measured **six distinct resolutions** across 30
cameras and a 7x spread in frame rate, so nothing about shape may be assumed estate-wide.

The decoder itself is per-camera for free: PyAV takes the codec from each container's own header.
What is *not* free is the inference shape, which is what this module computes.
"""

from __future__ import annotations

from dataclasses import dataclass

from .thresholds import DEFAULTS, IMGSZ_STEPS, AnalyticsThresholds


@dataclass(frozen=True)
class CameraCapabilities:
    """What one camera actually is, read from its own container — never from the registry's claim."""

    width: int
    height: int
    codec: str
    #: Container-declared rate. Kept for the delta against the measured one, which is a product
    #: feature (Pillar 1), never as an input to anything that must be correct.
    declared_fps: float | None = None
    #: Measured from PTS after the connect burst. `None` means *could not measure*, never zero.
    measured_fps: float | None = None

    @property
    def resolution(self) -> str:
        return f"{self.width}x{self.height}"

    @property
    def effective_fps(self) -> float:
        """The rate handed to ByteTrack's motion model.

        Measured wins. Declared is the fallback and 25.0 the last resort — ByteTrack needs *a*
        number for its track buffer, and refusing to track a camera whose rate we could not measure
        would turn an unknown into an outage.
        """
        for candidate in (self.measured_fps, self.declared_fps):
            if candidate is not None and candidate > 0:
                return float(candidate)
        return 25.0


def inference_size(
    capabilities: CameraCapabilities, thresholds: AnalyticsThresholds = DEFAULTS
) -> int:
    """The `imgsz` for this camera: its own long edge, clamped and rounded to YOLO's stride.

    Rounding here rather than letting ultralytics do it silently is the point — the number in the
    bench table has to be the number that ran. A 640x480 camera infers at 640 and a 1080p camera at
    960; feeding both through one fixed shape would either waste an order of magnitude of compute on
    the small one or discard half the pixels of the large one.
    """
    long_edge = max(capabilities.width, capabilities.height)
    clamped = min(max(long_edge, thresholds.imgsz_min), thresholds.imgsz_max)
    rounded = int(round(clamped / IMGSZ_STEPS)) * IMGSZ_STEPS
    return max(thresholds.imgsz_min, rounded)
