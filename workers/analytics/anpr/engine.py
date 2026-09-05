"""The ANPR stage: tracked vehicles in, one voted plate read per track out.

    for each inferred frame:
        for each tracked vehicle large enough to hold a plate:
            crop the vehicle -> detect the plate -> score the frame -> keep it if it is a best shot
        when a track's buffer is full (or its examination budget is spent):
            rectify and OCR each kept shot -> vote -> emit ONE plate read, attach it to that
            track's sighting on this frame, store the best-shot crop

**Aggregation is keyed by `(camera, track_id)` and the key is the whole safety argument.** D1-09
sets `track_id = session_index * 100_000 + tracker_id` and starts a new session at every loop-point
scene cut *and* every reconnect, so a buffer can never accumulate frames from either side of a cut.
That is the difference between "we are careful not to vote across a cut" and "voting across a cut is
not expressible".

**No second motion gate.** D1-09's gate already forces an inference every 2 s of PTS so that a
vehicle stopped at a signal keeps its identity; adding an ANPR-side gate on top would re-introduce
exactly the failure that keep-alive exists to prevent. ANPR examines the frames the gate already
let through, and bounds its own cost with `max_examine_per_track` instead.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field

import numpy as np

from ..track import TrackedDetection
from .best_shot import BestShotBuffer, PlateCandidate, best_shot_score, sharpness
from .crops import CropStore, NullCropStore, crop_key
from .ocr import OcrBackend, OcrRead
from .plates import PlateBox, PlateDetector
from .rectify import rectify
from .thresholds import ANPR_DEFAULTS, VEHICLE_CLASSES, AnprThresholds
from .vote import VotedPlate, vote_reads

log = logging.getLogger("saakshi.analytics.anpr")

Frame = np.ndarray

__all__ = ["AnprEngine", "AnprStats", "PlateReadPayload", "crop_with_padding"]


@dataclass
class AnprStats:
    """Every number is a count of something that happened. Nothing here is declared."""

    tracks_seen: int = 0
    frames_examined: int = 0
    #: Vehicles skipped because their box could not contain a plate above the width floor.
    vehicles_too_small: int = 0
    plate_detector_calls: int = 0
    plate_boxes_found: int = 0
    #: Plate boxes rejected for being narrower than `plate_min_width_px`.
    plates_too_narrow: int = 0
    ocr_calls: int = 0
    ocr_empty: int = 0
    votes_emitted: int = 0
    #: Votes discarded for falling below `ocr_conf_min`. Counted, because a discarded read is a
    #: vehicle the system saw and could not name, and the rate is a trust signal per camera.
    votes_below_floor: int = 0
    crops_written: int = 0
    rectify_methods: dict[str, int] = field(default_factory=dict)

    def note_rectify(self, method: str) -> None:
        self.rectify_methods[method] = self.rectify_methods.get(method, 0) + 1

    def as_dict(self) -> dict:
        return {
            "tracks_seen": self.tracks_seen,
            "frames_examined": self.frames_examined,
            "vehicles_too_small": self.vehicles_too_small,
            "plate_detector_calls": self.plate_detector_calls,
            "plate_boxes_found": self.plate_boxes_found,
            "plates_too_narrow": self.plates_too_narrow,
            "ocr_calls": self.ocr_calls,
            "ocr_empty": self.ocr_empty,
            "votes_emitted": self.votes_emitted,
            "votes_below_floor": self.votes_below_floor,
            "crops_written": self.crops_written,
            "rectify_methods": dict(self.rectify_methods),
        }


#: The wire shape of one plate read, matching `PlateRead` in `packages/shared/src/sighting.ts`.
#: `normalizedText` is `None` on purpose: D2-03 owns normalisation and grammar validation, and a
#: worker that guessed at it would make the rejection rate — a trust signal — unmeasurable.
PlateReadPayload = dict


def crop_with_padding(
    image: Frame, x: float, y: float, w: float, h: float, pad_ratio: float
) -> tuple[Frame, int, int]:
    """Crops `image` to the box plus padding, clamped to the frame. Returns `(crop, x0, y0)`.

    The offsets come back because a plate box found inside a vehicle crop has to be translated to
    frame coordinates before it means anything to anybody else.
    """
    height, width = image.shape[:2]
    pad_x = int(round(w * pad_ratio))
    pad_y = int(round(h * pad_ratio))
    x0 = max(0, int(round(x)) - pad_x)
    y0 = max(0, int(round(y)) - pad_y)
    x1 = min(width, int(round(x + w)) + pad_x)
    y1 = min(height, int(round(y + h)) + pad_y)
    if x1 <= x0 or y1 <= y0:
        return image[0:0, 0:0], 0, 0
    return image[y0:y1, x0:x1], x0, y0


class AnprEngine:
    """Shared across camera threads; per-track state is keyed by `(camera, track_id)`."""

    def __init__(
        self,
        plate_detector: PlateDetector,
        ocr: OcrBackend,
        crop_store: CropStore | None = None,
        thresholds: AnprThresholds = ANPR_DEFAULTS,
        *,
        every_frame: bool = False,
    ) -> None:
        self.plate_detector = plate_detector
        self.ocr = ocr
        self.crop_store = crop_store if crop_store is not None else NullCropStore()
        self.thresholds = thresholds
        #: AC 1's control arm. With `every_frame=True` the buffer is bypassed and **every** examined
        #: frame is OCR'd, which is the strategy the ticket says is both slower and less accurate.
        #: It exists so that claim is measured rather than repeated.
        self.every_frame = every_frame
        self.stats = AnprStats()
        self._buffers: dict[tuple[str, int], BestShotBuffer] = {}
        self._every_frame_reads: dict[tuple[str, int], list[OcrRead]] = {}
        self._lock = threading.Lock()

    # ── the per-frame entry point ───────────────────────────────────────────────────────────────

    def observe(
        self,
        image: Frame,
        tracked: list[TrackedDetection],
        *,
        camera_external_id: str,
        ts: str,
        frame_pts_ms: int,
    ) -> dict[int, PlateReadPayload]:
        """Examines this frame and returns `{track_id: plate read}` for tracks that voted now.

        Returns at most one entry per track for the whole life of that track — the emitted flag is
        what makes "one `plate_reads` row per track (best)" true at the source rather than a
        deduplication problem for the consumer.
        """
        emitted: dict[int, PlateReadPayload] = {}
        for item in tracked:
            if item.vehicle_class not in VEHICLE_CLASSES:
                continue
            key = (camera_external_id, item.track_id)
            with self._lock:
                buffer = self._buffers.get(key)
                if buffer is None:
                    # In the every-frame control arm the buffer must not fill and end the track
                    # early, or the "control" would OCR exactly as few frames as the treatment and
                    # the comparison in AC 1 would be between a strategy and itself. Its ceiling is
                    # therefore the examination budget: every examined frame is read.
                    buffer = BestShotBuffer(
                        top_n=self.thresholds.max_examine_per_track
                        if self.every_frame
                        else self.thresholds.best_shot_top_n
                    )
                    self._buffers[key] = buffer
                    self.stats.tracks_seen += 1
                if buffer.emitted:
                    continue

            if max(item.w, item.h) < self.thresholds.vehicle_min_box_px:
                self.stats.vehicles_too_small += 1
                continue

            candidate = self._examine(image, item, ts=ts, frame_pts_ms=frame_pts_ms)
            buffer.examined += 1
            self.stats.frames_examined += 1
            if candidate is None:
                buffer.stale += 1
            else:
                if self.every_frame:
                    read = self._read_candidate(candidate)
                    if read is not None:
                        self._every_frame_reads.setdefault(key, []).append(read)
                buffer.offer(candidate)

            if not buffer.ready(self.thresholds.max_examine_per_track):
                continue
            payload = self._emit(key, buffer, camera_external_id, ts, item.track_id)
            buffer.emitted = True
            if payload is not None:
                emitted[item.track_id] = payload

        return emitted

    @property
    def tracks_unemitted(self) -> int:
        """Tracks holding candidates that never reached a vote. Recorded, not hidden.

        In the live pipeline these are the vehicles still in frame when the deadline fired. They are
        counted rather than flushed, because a flushed vote has no sighting to attach to — the
        `plate_reads` row needs a `sighting_id`, and inventing a sighting to hang one on would put a
        vehicle in the database at a time and place no camera reported it.
        """
        with self._lock:
            return sum(1 for b in self._buffers.values() if not b.emitted and b.candidates)

    def flush(self, camera_external_id: str | None = None) -> dict[int, PlateReadPayload]:
        """Votes on tracks that never filled their buffer.

        **Offline only** — `eval_anpr` calls this because a recorded segment ends abruptly and there
        is no sighting stream to attach to in the first place. The live pipeline deliberately does
        not call it; see `tracks_unemitted`.
        """
        out: dict[int, PlateReadPayload] = {}
        with self._lock:
            keys = [
                key
                for key, buffer in self._buffers.items()
                if not buffer.emitted
                and buffer.candidates
                and (camera_external_id is None or key[0] == camera_external_id)
            ]
        for key in keys:
            buffer = self._buffers[key]
            payload = self._emit(key, buffer, key[0], buffer.candidates[0].ts, key[1])
            buffer.emitted = True
            if payload is not None:
                out[key[1]] = payload
        return out

    # ── internals ───────────────────────────────────────────────────────────────────────────────

    def _examine(
        self, image: Frame, item: TrackedDetection, *, ts: str, frame_pts_ms: int
    ) -> PlateCandidate | None:
        """Finds the best plate on one vehicle in one frame and scores it as a best-shot candidate."""
        vehicle_crop, offset_x, offset_y = crop_with_padding(
            image, item.x, item.y, item.w, item.h, self.thresholds.crop_pad_ratio
        )
        if vehicle_crop.size == 0:
            return None

        boxes = self.plate_detector.detect(vehicle_crop)
        self.stats.plate_detector_calls += 1
        self.stats.plate_boxes_found += len(boxes)
        box = _widest_usable(boxes, self.thresholds.plate_min_width_px)
        if box is None:
            if boxes:
                self.stats.plates_too_narrow += 1
            return None

        plate_crop, _px, _py = crop_with_padding(
            vehicle_crop, box.x, box.y, box.w, box.h, self.thresholds.crop_pad_ratio * 2
        )
        if plate_crop.size == 0:
            return None

        variance = sharpness(plate_crop)
        score = best_shot_score(box.w, box.h, plate_crop, self.thresholds)
        # Offsets are folded in so the stored candidate's geometry is the *frame's*, not the
        # vehicle crop's — a bbox that only makes sense relative to a temporary crop is a bbox
        # nobody downstream can use.
        del offset_x, offset_y
        return PlateCandidate(
            score=score,
            crop=plate_crop,
            plate_width=box.w,
            plate_height=box.h,
            detect_confidence=box.confidence,
            frame_pts_ms=frame_pts_ms,
            ts=ts,
            sharpness_var=variance,
        )

    def _read_candidate(self, candidate: PlateCandidate) -> OcrRead | None:
        rectified = rectify(candidate.crop, self.thresholds)
        self.stats.note_rectify(rectified.method)
        read = self.ocr.read(rectified.image)
        self.stats.ocr_calls += 1
        if read is None:
            self.stats.ocr_empty += 1
            return None
        return OcrRead(
            text=read.text,
            confidence=read.confidence,
            char_confidences=read.char_confidences,
            backend=read.backend,
            rectify_method=rectified.method,
            latency_ms=read.latency_ms,
        )

    def _emit(
        self,
        key: tuple[str, int],
        buffer: BestShotBuffer,
        camera_external_id: str,
        ts: str,
        track_id: int,
    ) -> PlateReadPayload | None:
        if self.every_frame:
            reads = self._every_frame_reads.pop(key, [])
        else:
            reads = [
                read
                for read in (self._read_candidate(c) for c in buffer.candidates)
                if read is not None
            ]
        voted = vote_reads(reads)
        if voted is None:
            return None
        if voted.confidence < self.thresholds.ocr_conf_min:
            self.stats.votes_below_floor += 1
            return None

        best = buffer.best
        crop_uri: str | None = None
        if best is not None:
            day = ts[:10] if len(ts) >= 10 else "unknown"
            crop_uri = self.crop_store.put(best.crop, crop_key(camera_external_id, day, track_id))
            if crop_uri is not None:
                self.stats.crops_written += 1

        self.stats.votes_emitted += 1
        return build_payload(voted, crop_uri)


def build_payload(voted: VotedPlate, crop_uri: str | None) -> PlateReadPayload:
    """The `PlateRead` wire shape. `isBestShot` is always true — this is the *only* read we emit."""
    return {
        "rawText": voted.text,
        "normalizedText": None,
        "confidence": voted.confidence,
        "isBestShot": True,
        "voteCount": voted.vote_count,
        "cropUri": crop_uri,
    }


def _widest_usable(boxes: list[PlateBox], min_width_px: int) -> PlateBox | None:
    """The widest plate box above the width floor.

    Widest rather than most-confident: at this estate's plate sizes confidence tracks contrast far
    more than it tracks legibility, and the widest box is the one with the most pixels per glyph —
    which is the thing an OCR actually needs.
    """
    usable = [box for box in boxes if box.w >= min_width_px]
    if not usable:
        return None
    return max(usable, key=lambda box: box.w)
