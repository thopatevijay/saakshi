"""ANPR — the challenge's one mandatory analytic.

    track (D1-09) -> best-shot scoring -> plate detect -> rectify -> OCR
                  -> multi-frame vote across the track -> one plate_reads row

Two design moves do most of the accuracy work and neither needs a CV specialist:

1. **Best-shot selection.** OCR the few best frames of a vehicle track, not every frame. Naively
   OCRing every frame is both slower *and* less accurate — the extra reads are the blurred,
   oblique, half-occluded ones, and they outvote the good frames.
2. **Multi-frame voting.** Aggregate several reads of the same plate, weighted per character by the
   OCR's own confidence, so per-frame noise cancels instead of accumulating.

Everything upstream of this package is D1-09's and untouched: PTS-driven timing, the connect-burst
discard, the motion gate with its keep-alive, and the session-qualified `track_id`. A vote is
aggregated per `(camera, track_id)`, and because `track_id = session_index * 100_000 + tracker_id`
resets at every scene cut and every reconnect, **no vote can span a loop-point cut** by
construction rather than by care.
"""

from __future__ import annotations

from .best_shot import BestShotBuffer, PlateCandidate, best_shot_score, frontality, sharpness
from .crops import CropStore, LocalCropStore, NullCropStore, crop_key
from .ocr import OCR_BACKENDS, DEFAULT_OCR_BACKEND, OcrBackend, OcrRead, create_ocr_backend
from .plates import PlateBox, PlateDetector
from .rectify import RectifyResult, plate_quad, rectify
from .thresholds import ANPR_DEFAULTS, AnprThresholds
from .vote import VotedPlate, vote_reads

__all__ = [
    "ANPR_DEFAULTS",
    "AnprThresholds",
    "BestShotBuffer",
    "CropStore",
    "DEFAULT_OCR_BACKEND",
    "LocalCropStore",
    "NullCropStore",
    "OCR_BACKENDS",
    "OcrBackend",
    "OcrRead",
    "PlateBox",
    "PlateCandidate",
    "PlateDetector",
    "RectifyResult",
    "VotedPlate",
    "best_shot_score",
    "create_ocr_backend",
    "crop_key",
    "frontality",
    "plate_quad",
    "rectify",
    "sharpness",
    "vote_reads",
]
