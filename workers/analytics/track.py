"""ByteTrack, wrapped so that a loop-point scene cut ends one tracking *session* and starts another.

The whole reason this file exists rather than calling `sv.ByteTrack` directly:

`sightings.track_id` is an integer, and ByteTrack restarts its counter at 1 after `reset()`. A feed
that loops therefore produces `track_id = 3` before the cut and `track_id = 3` after it, for two
unrelated vehicles. D2-08's identity linking joins on exactly that column. So every id is offset by
its session — `session_index * TRACK_SESSION_STRIDE + tracker_id` — which makes "no identity bleed
across the cut" a property that can be **queried in SQL**, not merely asserted in a comment.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np

from .detect import Detection
from .thresholds import DEFAULTS, AnalyticsThresholds

# `supervision` deprecated the public `sv.ByteTrack` alias in 0.28 with removal announced for 0.31.
# There is no non-deprecated replacement in 0.30.1 — `supervision.tracker.byte_tracker.core` carries
# the same wrapper. Filtering the warning here keeps the suite's output honest without hiding the
# fact; `workers/requirements.txt` pins `<0.31` and BL-01 carries the note.
warnings.filterwarnings(
    "ignore", message=r".*`ByteTrack` was deprecated.*", category=FutureWarning
)


@dataclass(frozen=True)
class TrackedDetection:
    """One detection that survived tracking, carrying its session-qualified id."""

    track_id: int
    session_index: int
    tracker_id: int
    x: float
    y: float
    w: float
    h: float
    confidence: float
    vehicle_class: str


class SessionTracker:
    """One ByteTrack instance per camera, reset at every scene cut and every reconnect."""

    def __init__(
        self,
        frame_rate: float,
        thresholds: AnalyticsThresholds = DEFAULTS,
    ) -> None:
        import supervision as sv  # noqa: PLC0415 — heavy import, deferred

        self._sv = sv
        self.thresholds = thresholds
        # ByteTrack's track buffer is expressed in frames; handing it the camera's *measured* rate
        # is what makes "30 frames" mean the same wall-clock duration on a 4 fps camera and a 30 fps
        # one. D0-01 measured a 7x spread across this estate, so a fixed rate would be wrong on most.
        self.frame_rate = max(1.0, float(frame_rate))
        self.session_index = 0
        self._tracker = sv.ByteTrack(frame_rate=self.frame_rate)

    def new_session(self) -> int:
        """Ends the current tracking session and begins a fresh one. Returns the new index."""
        self.session_index += 1
        self._tracker.reset()
        return self.session_index

    def update(self, detections: list[Detection]) -> list[TrackedDetection]:
        sv = self._sv
        if detections:
            xyxy = np.array(
                [[d.x, d.y, d.x + d.w, d.y + d.h] for d in detections], dtype=np.float32
            )
            confidence = np.array([d.confidence for d in detections], dtype=np.float32)
            class_id = np.arange(len(detections), dtype=int)
        else:
            # ByteTrack must still be stepped on an empty frame or its tracks never age out.
            xyxy = np.empty((0, 4), dtype=np.float32)
            confidence = np.empty((0,), dtype=np.float32)
            class_id = np.empty((0,), dtype=int)

        tracked = self._tracker.update_with_detections(
            sv.Detections(xyxy=xyxy, confidence=confidence, class_id=class_id)
        )

        out: list[TrackedDetection] = []
        tracker_ids = tracked.tracker_id
        if tracker_ids is None:
            return out

        for i, tracker_id in enumerate(tracker_ids.tolist()):
            # `class_id` carried the index into `detections`, so the class survives the round trip.
            # ByteTrack does not preserve arbitrary payloads, and re-deriving the class by matching
            # boxes back would be guesswork on any frame with overlapping vehicles.
            source_index = int(tracked.class_id[i]) if tracked.class_id is not None else -1
            source = detections[source_index] if 0 <= source_index < len(detections) else None
            x1, y1, x2, y2 = (float(v) for v in tracked.xyxy[i])
            confidence_value = (
                float(tracked.confidence[i])
                if tracked.confidence is not None
                else (source.confidence if source else 0.0)
            )
            out.append(
                TrackedDetection(
                    track_id=self.session_index * self.thresholds.track_session_stride
                    + int(tracker_id),
                    session_index=self.session_index,
                    tracker_id=int(tracker_id),
                    x=max(0.0, x1),
                    y=max(0.0, y1),
                    w=max(1e-3, x2 - x1),
                    h=max(1e-3, y2 - y1),
                    confidence=min(1.0, max(0.0, confidence_value)),
                    vehicle_class=source.vehicle_class if source else "unknown",
                )
            )
        return out
