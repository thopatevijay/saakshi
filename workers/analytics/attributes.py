"""Vehicle colour, body type, and best-shot selection.

Deliberately cheap and deliberately modest. Colour is an HSV histogram over the interior of the
vehicle box against a fixed ten-entry palette; body type is the detector's own class, renamed and
nothing more. No make, no model, no year — D3-03 owns the harder identity work, and a make/model
claim from a 40-pixel-tall box on a traffic camera would be a claim nobody measured.

Three properties this module exists to guarantee:

1. **A colour always arrives with its confidence, and a weak read is named `unknown`.**
   `attributes_low_confidence` is a first-class output, not a log line. The rate at which it fires
   on night frames and on two-wheelers is a *measurement we report*, not a number to tune away by
   lowering the threshold until everything looks confident.

2. **Best shots are per track *session*, never per raw tracker id.** D1-09 measured raw ByteTrack
   ids 1 and 2 being reused across sessions 6 and 9 on `cam03` inside a single run. The stored
   `track_id` is already session-qualified (`session * TRACK_SESSION_STRIDE + tracker_id`), so
   keying on `(camera, track_id)` is what makes "one best shot per vehicle appearance" true across
   a loop-point cut. Grouping on the raw tracker id would silently merge two different vehicles.

3. **Exactly one crop leaves this module per track session.** That is the storage argument in
   PROJECT.md §9: at 80k cameras, a crop per sighting is 17 TB/year turning into something nobody
   can afford. The selector holds one candidate per track in memory and emits it once.

Timing is PTS throughout (`frame_pts_ms`). The selector's expiry clock is stream time, never wall
time, for the reason CLAUDE.md states: the gateway replays a buffered GOP on connect, so an
arrival-time clock produces impossible intervals after every reconnect.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Iterable

import cv2
import numpy as np

log = logging.getLogger("saakshi.analytics")

__all__ = [
    "PALETTE",
    "ACHROMATIC_BANDS",
    "HUE_BANDS",
    "ColorRead",
    "BestShot",
    "BestShotSelector",
    "body_type",
    "classify_color",
    "crop_box",
    "best_shot_score",
    "encode_jpeg",
    "sharpness",
    "COLOR_CONFIDENCE_MIN",
    "COLOR_MARGIN_MIN",
]

# ── Palette ─────────────────────────────────────────────────────────────────────────────────────

#: The ten names a colour read may take, plus `unknown` for a read that could not be separated.
#:
#: Fixed and small on purpose. A query is "white hatchback near Kalupur", not "pearl-effect
#: alabaster", and a palette with sixty entries produces sixty ways to miss the vehicle you want.
#: `other` is a real answer — orange, pink and purple vehicles exist on this estate and calling one
#: of them "red" to avoid an awkward bucket would be a worse lie than admitting the bucket.
PALETTE: tuple[str, ...] = (
    "white",
    "silver",
    "grey",
    "black",
    "red",
    "blue",
    "yellow",
    "green",
    "brown",
    "other",
)

UNKNOWN = "unknown"

# OpenCV's HSV ranges, which are not the ones every other tool uses: H is 0-179 (degrees halved),
# S and V are 0-255. Every constant below is in those units.

#: Saturation below this is treated as achromatic — a grey/white/black/silver body panel.
#:
#: 55/255 ≈ 22% saturation. Measured on the D0-01 recon stills: silver and white vehicles under
#: Gujarat daylight sit at S ≈ 15-45, while a genuinely coloured car sits well above 80. The gap is
#: wide, which is why a single cut works; a narrower gap would need a soft vote.
CHROMA_S_MIN = 55

#: Value below this is too dark for hue to mean anything — a shadowed wheel arch reports a random
#: hue at S=200 because the sensor noise dominates. Such pixels vote achromatic, not chromatic.
CHROMA_V_MIN = 45

#: Achromatic pixels are bucketed by the **median** V of the achromatic set, so they never fragment
#: across three neighbouring names. A silver car whose panels straddle the silver/white boundary
#: must not be punished with a low confidence for being silver.
#:
#: (upper bound of V, name) — first match wins.
ACHROMATIC_BANDS: tuple[tuple[int, str], ...] = (
    (60, "black"),
    (125, "grey"),
    (190, "silver"),
    (256, "white"),
)

#: (hue lower inclusive, hue upper exclusive, name). Red wraps, so it appears twice.
#:
#: Orange (H 10-19 at high V) has no palette entry and maps to `other` rather than being annexed by
#: red or yellow. Brown is the same hue band at low V — which is exactly what a brown or beige car
#: is, and what a dusty one becomes.
HUE_BANDS: tuple[tuple[int, int, str], ...] = (
    (0, 8, "red"),
    (8, 20, "brown_or_orange"),  # split by V below
    (20, 35, "yellow"),
    (35, 85, "green"),
    (85, 135, "blue"),
    (135, 170, "other"),  # violet / magenta / pink
    (170, 180, "red"),
)

#: Inside the brown/orange hue band, V below this is brown; above it is `other` (orange).
BROWN_V_MAX = 150

#: Winning share of the counted pixels below which the read is `unknown`.
#:
#: 0.35, not 0.5: a vehicle box always contains window glass, tyres and some road, so even a
#: perfectly white car rarely exceeds 0.7. PROVISIONAL — chosen from the recon-still corpus, and the
#: measured low-confidence rate is reported rather than the threshold being moved until it looks good.
COLOR_CONFIDENCE_MIN = 0.35

#: The winner must also beat the runner-up by this share. Two colours at 0.36 and 0.35 is not a
#: colour read, it is a coin toss with a decimal point.
COLOR_MARGIN_MIN = 0.08

#: The interior of the box that votes, as fractions of width and height.
#:
#: Not the whole box. The bottom quarter is wheels, shadow and road; the outer fifth in x is
#: background wherever the box is loose. Body panels live in the upper-middle band, and the crop
#: stored as evidence is still the *full* box — this inset governs voting only.
INTERIOR_X = (0.20, 0.80)
INTERIOR_Y = (0.20, 0.72)

#: Below this many voting pixels the read is refused outright. A 12x9 interior is noise.
MIN_VOTING_PIXELS = 120


@dataclass(frozen=True)
class ColorRead:
    """One colour read. `low_confidence` is part of the answer, not commentary on it."""

    name: str
    confidence: float
    low_confidence: bool
    #: Share of the interior that was chromatic at all. Diagnostic: a night frame drives this to ~0.
    chroma_share: float
    #: Second-place palette entry and its share, so a near-miss is inspectable after the fact.
    runner_up: str | None = None
    runner_up_confidence: float = 0.0


# ── Body type ───────────────────────────────────────────────────────────────────────────────────

#: `vehicle_class` (the detector's answer) -> body type (the attribute a query filters on).
#:
#: A rename and nothing more, because that is all the evidence supports. COCO has no auto-rickshaw
#: class: D1-09 recorded whichever of `car`/`motorcycle` COCO said, and inventing `auto_rickshaw`
#: here would be a claim no model made. The mapping is kept explicit so that when a rickshaw-capable
#: detector lands, exactly one table changes.
BODY_TYPE_BY_CLASS: dict[str, str] = {
    "car": "car",
    "truck": "truck",
    "bus": "bus",
    "motorcycle": "two_wheeler",
    "bicycle": "two_wheeler",
    "auto_rickshaw": "auto_rickshaw",
}


def body_type(vehicle_class: str) -> str | None:
    """Body type for a detector class, or `None` for a class that is not a vehicle.

    `person` returns `None` rather than a body type: a pedestrian near a vehicle of interest is
    evidence (D1-09 keeps the class for that reason) but a person has no body type, and writing one
    would put pedestrians into vehicle attribute queries.
    """
    return BODY_TYPE_BY_CLASS.get(vehicle_class)


# ── Colour ──────────────────────────────────────────────────────────────────────────────────────


def _interior(crop: np.ndarray) -> np.ndarray:
    """The voting region: the body-panel band, not the whole box."""
    h, w = crop.shape[:2]
    x0, x1 = int(w * INTERIOR_X[0]), max(int(w * INTERIOR_X[1]), int(w * INTERIOR_X[0]) + 1)
    y0, y1 = int(h * INTERIOR_Y[0]), max(int(h * INTERIOR_Y[1]), int(h * INTERIOR_Y[0]) + 1)
    inner = crop[y0:y1, x0:x1]
    # A box so small that the inset leaves nothing votes on the whole thing rather than on nothing.
    return inner if inner.size > 0 else crop


def _achromatic_name(median_v: float) -> str:
    for upper, name in ACHROMATIC_BANDS:
        if median_v < upper:
            return name
    return "white"


def _hue_name(hue: int, value: int) -> str:
    for low, high, name in HUE_BANDS:
        if low <= hue < high:
            if name == "brown_or_orange":
                return "brown" if value < BROWN_V_MAX else "other"
            return name
    return "other"


def classify_color(crop: np.ndarray) -> ColorRead:
    """Palette colour of one vehicle crop, with the confidence that belongs to it.

    Two-stage, and the staging is the whole trick:

    * **Achromatic pixels vote as one block.** Their name comes from the median V of the block, so
      white/silver/grey/black cannot split three ways and hand a silver car a 0.3 confidence for
      being unambiguously silver.
    * **Chromatic pixels vote per hue band.** Bands are wide (red, blue, yellow, green, brown) —
      wide enough that a shadowed red panel and a sunlit one land in the same bucket.

    Confidence is the winner's share of every counted pixel, and the read is refused — named
    `unknown` with the flag set — when that share is below `COLOR_CONFIDENCE_MIN` or when it fails
    to beat the runner-up by `COLOR_MARGIN_MIN`. Refusing is the point: a control room that cannot
    trust "white" will not use the colour filter at all.
    """
    if crop is None or crop.size == 0 or crop.ndim != 3:
        return ColorRead(UNKNOWN, 0.0, True, 0.0)

    inner = _interior(crop)
    if inner.shape[0] * inner.shape[1] < MIN_VOTING_PIXELS:
        return ColorRead(UNKNOWN, 0.0, True, 0.0)

    hsv = cv2.cvtColor(inner, cv2.COLOR_BGR2HSV)
    h = hsv[:, :, 0].reshape(-1)
    s = hsv[:, :, 1].reshape(-1)
    v = hsv[:, :, 2].reshape(-1)
    total = int(h.size)

    chromatic = (s >= CHROMA_S_MIN) & (v >= CHROMA_V_MIN)
    chromatic_count = int(np.count_nonzero(chromatic))
    achromatic_count = total - chromatic_count

    votes: dict[str, int] = {}

    if achromatic_count > 0:
        median_v = float(np.median(v[~chromatic]))
        votes[_achromatic_name(median_v)] = achromatic_count

    if chromatic_count > 0:
        hue_c = h[chromatic]
        val_c = v[chromatic]
        # One pass over the bands rather than a per-pixel Python loop: at 1080p interiors this is
        # the difference between microseconds and a visible stall in the frame loop.
        for low, high, name in HUE_BANDS:
            in_band = (hue_c >= low) & (hue_c < high)
            count = int(np.count_nonzero(in_band))
            if count == 0:
                continue
            if name == "brown_or_orange":
                dark = int(np.count_nonzero(val_c[in_band] < BROWN_V_MAX))
                if dark:
                    votes["brown"] = votes.get("brown", 0) + dark
                if count - dark:
                    votes["other"] = votes.get("other", 0) + (count - dark)
            else:
                votes[name] = votes.get(name, 0) + count

    if not votes:
        return ColorRead(UNKNOWN, 0.0, True, 0.0)

    ranked = sorted(votes.items(), key=lambda kv: kv[1], reverse=True)
    name, count = ranked[0]
    confidence = count / total
    runner_up, runner_up_share = (ranked[1][0], ranked[1][1] / total) if len(ranked) > 1 else (None, 0.0)
    chroma_share = chromatic_count / total

    low = confidence < COLOR_CONFIDENCE_MIN or (confidence - runner_up_share) < COLOR_MARGIN_MIN
    return ColorRead(
        name=UNKNOWN if low else name,
        confidence=round(confidence, 3),
        low_confidence=low,
        chroma_share=round(chroma_share, 3),
        runner_up=runner_up,
        runner_up_confidence=round(runner_up_share, 3),
    )


# ── Crops and best-shot scoring ─────────────────────────────────────────────────────────────────


def crop_box(
    image: np.ndarray, x: float, y: float, w: float, h: float, pad: float = 0.06
) -> np.ndarray:
    """The stored evidence crop: the full detector box plus a small margin, clipped to the frame.

    The margin is deliberate. A crop cut exactly at the box is unreadable as evidence — an officer
    verifying an alert in three seconds needs a sliver of context to see *where* on the road the
    vehicle was. It also gives D2-01's plate detector room when the box clipped a bumper.
    """
    height, width = image.shape[:2]
    px, py = w * pad, h * pad
    x0 = max(0, int(round(x - px)))
    y0 = max(0, int(round(y - py)))
    x1 = min(width, int(round(x + w + px)))
    y1 = min(height, int(round(y + h + py)))
    if x1 <= x0 or y1 <= y0:
        return np.empty((0, 0, 3), dtype=image.dtype)
    return image[y0:y1, x0:x1]


def sharpness(crop: np.ndarray) -> float:
    """Variance of the Laplacian — the standard cheap focus measure. Higher is sharper.

    Absolute values are not comparable across cameras (a 480p feed cannot reach a 1080p feed's
    variance), which is why the score below normalises it against a reference rather than using it
    raw. Within one track on one camera, which is the only place it is compared, it is exactly the
    right signal: the frame where the vehicle was not smeared by motion blur.
    """
    if crop is None or crop.size == 0:
        return 0.0
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


#: Box diagonal, in pixels, at which the size term saturates. Beyond this a vehicle is close enough
#: that more pixels stop buying legibility.
BEST_SHOT_REF_PX = 160.0
#: Laplacian variance at which the focus term saturates. Measured on the recon stills: sharp
#: daylight vehicle crops sit at 150-600, motion-blurred ones below 40.
BEST_SHOT_REF_SHARPNESS = 120.0
#: Multiplier applied when the box touches the frame edge — a half-visible vehicle is poor evidence
#: however large and sharp it is.
EDGE_PENALTY = 0.45
#: Pixels from the border within which a box counts as touching it.
EDGE_MARGIN_PX = 2.0


def best_shot_score(
    *,
    det_confidence: float,
    w: float,
    h: float,
    focus: float,
    frame_width: int,
    frame_height: int,
    x: float,
    y: float,
) -> float:
    """How good a piece of evidence one observation of a vehicle is, in 0-1.

    A product of four terms, all of which must be decent for the shot to win:

    * detector confidence — the model's own opinion of the box;
    * apparent size, saturating at `BEST_SHOT_REF_PX`;
    * focus, saturating at `BEST_SHOT_REF_SHARPNESS`;
    * an edge penalty, because a vehicle half out of frame cannot be identified from its crop.

    A product, not a weighted sum, so that a zero anywhere cannot be averaged away by the others.
    """
    size_term = min(1.0, ((w * w + h * h) ** 0.5) / BEST_SHOT_REF_PX)
    focus_term = min(1.0, max(0.0, focus) / BEST_SHOT_REF_SHARPNESS)
    touches_edge = (
        x <= EDGE_MARGIN_PX
        or y <= EDGE_MARGIN_PX
        or (x + w) >= frame_width - EDGE_MARGIN_PX
        or (y + h) >= frame_height - EDGE_MARGIN_PX
    )
    edge_term = EDGE_PENALTY if touches_edge else 1.0
    return round(max(0.0, min(1.0, det_confidence)) * size_term * focus_term * edge_term, 4)


def encode_jpeg(crop: np.ndarray, quality: int = 82) -> bytes:
    """JPEG bytes for one crop. Quality 82 is the sizing model's assumption, so it is the default.

    PROJECT.md §9 budgets ~15 KB per stored crop across 80k cameras. That figure is an input to a
    17 TB/year number, so the encoder setting that produces it is a documented constant rather than
    a library default that could drift.
    """
    ok, buffer = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    if not ok:
        return b""
    return bytes(buffer.tobytes())


# ── Best-shot selection ─────────────────────────────────────────────────────────────────────────


@dataclass
class BestShot:
    """The single observation of one track session that is worth storing."""

    camera_id: str
    #: Session-qualified: `session * TRACK_SESSION_STRIDE + tracker_id`. Never the raw tracker id.
    track_id: int
    ts: str
    frame_pts_ms: int
    vehicle_class: str
    det_confidence: float
    bbox: dict[str, float]
    score: float
    focus: float
    color: ColorRead
    body: str | None
    crop_jpeg: bytes
    #: Observations of this track that were considered before this one won. The compression ratio.
    observations: int = 1


@dataclass
class _Candidate:
    shot: BestShot
    last_pts_ms: int


#: PTS milliseconds a track may go unseen before its best shot is flushed.
#:
#: 3 s of *stream* time, comfortably above the 2 s motion-gate keep-alive so a vehicle stopped at a
#: signal is refreshed before it is flushed, and far below the interval at which holding candidates
#: would matter for memory.
TRACK_IDLE_FLUSH_PTS_MS = 3_000

#: Hard cap on candidates held per camera. The oldest is flushed when it is exceeded.
#:
#: The bound is the point: "no unbounded memory over a 20-minute run" has to be true of this map as
#: well as of the decode loop, and a camera watching a jam can hold a lot of simultaneous tracks.
MAX_TRACKS_PER_CAMERA = 512


@dataclass
class BestShotSelectorStats:
    observations: int = 0
    flushed: int = 0
    dropped_no_crop: int = 0
    capacity_flushes: int = 0
    pts_rewind_flushes: int = 0


class BestShotSelector:
    """One best shot per `(camera, session-qualified track id)`, and nothing else leaves.

    The expiry clock is **PTS**, never wall time. A candidate is flushed when its track has not been
    seen for `TRACK_IDLE_FLUSH_PTS_MS` of stream time, when the camera's PTS rewinds (a reconnect
    replayed a buffered GOP, so the stream before and after is not continuous), when the caller ends
    a session at a scene cut, or when the run ends.

    Nothing here joins across a scene cut: the cut increments the tracking session, every id after
    it lands in a different `track_id` band by construction, and the pre-cut candidates are flushed
    at the cut. That is D1-09's measured constraint — raw ids 1 and 2 reused across sessions 6 and 9
    on one camera in one run — expressed as code rather than as a comment.
    """

    def __init__(
        self,
        idle_flush_pts_ms: int = TRACK_IDLE_FLUSH_PTS_MS,
        max_tracks_per_camera: int = MAX_TRACKS_PER_CAMERA,
    ) -> None:
        self.idle_flush_pts_ms = idle_flush_pts_ms
        self.max_tracks_per_camera = max_tracks_per_camera
        self._by_camera: dict[str, dict[int, _Candidate]] = {}
        self._last_pts: dict[str, int] = {}
        # One selector is shared by every camera thread, because the run's storage total is a
        # property of the run. Each camera has its own sub-dict, but `flush_all` iterates the outer
        # map while other threads are inserting into it — which is a `RuntimeError` waiting for a
        # 20-minute soak to find. The lock is uncontended in practice: it is held for a dictionary
        # operation, not across the JPEG encode.
        self._lock = threading.Lock()
        self.stats = BestShotSelectorStats()

    # -- offering ------------------------------------------------------------------------------

    def offer(self, shot: BestShot) -> list[BestShot]:
        """Consider one observation. Returns whatever that made ready to store (usually nothing).

        The return value is a list rather than an optional so that the caller has exactly one code
        path: everything the selector hands back is stored, and everything it keeps is invisible.
        """
        with self._lock:
            self.stats.observations += 1
            camera = self._by_camera.setdefault(shot.camera_id, {})
            ready: list[BestShot] = []

            previous_pts = self._last_pts.get(shot.camera_id)
            # The *last seen* PTS, not the highest ever seen.
            #
            # A running maximum is the bug this comment exists to prevent, and it was measured, not
            # imagined: a looping feed restarts its PTS near zero on every reconnect, so a
            # high-water mark is never reached again and every subsequent frame looks like a rewind.
            # On an eight-camera replay that turned 856 track sessions into 19,367 flushed
            # candidates — one crop per 1.3 sightings, which is precisely the unbounded-storage
            # design this ticket exists to refuse.
            #
            # The threshold is the idle window, so ordinary jitter (frames arriving slightly out of
            # presentation order) is not a discontinuity, while a loop or a reconnect plainly is.
            if previous_pts is not None and previous_pts - shot.frame_pts_ms > self.idle_flush_pts_ms:
                self.stats.pts_rewind_flushes += 1
                ready.extend(self._drain(camera))
            self._last_pts[shot.camera_id] = shot.frame_pts_ms

            existing = camera.get(shot.track_id)
            if existing is None:
                camera[shot.track_id] = _Candidate(shot=shot, last_pts_ms=shot.frame_pts_ms)
            else:
                existing.last_pts_ms = max(existing.last_pts_ms, shot.frame_pts_ms)
                observations = existing.shot.observations + 1
                if shot.score > existing.shot.score:
                    shot.observations = observations
                    existing.shot = shot
                else:
                    existing.shot.observations = observations

            ready.extend(self._expire_locked(shot.camera_id, shot.frame_pts_ms))

            if len(camera) > self.max_tracks_per_camera:
                oldest = min(camera, key=lambda tid: camera[tid].last_pts_ms)
                self.stats.capacity_flushes += 1
                ready.extend(self._take(camera, [oldest]))

            return ready

    # -- flushing ------------------------------------------------------------------------------

    def candidate_score(self, camera_id: str, track_id: int) -> float | None:  # noqa: D401
        """Score of the candidate currently held for a track, or `None` if there is none.

        Exists so the caller can skip JPEG encoding for an observation that cannot win. Encoding is
        the expensive half of the attribute stage, and encoding every observation of every track
        would put the whole stage into the throughput table for no benefit.
        """
        candidate = self._by_camera.get(camera_id, {}).get(track_id)
        return None if candidate is None else candidate.shot.score

    def expire(self, camera_id: str, now_pts_ms: int) -> list[BestShot]:
        """Flush candidates whose track has not been seen for `idle_flush_pts_ms` of PTS."""
        with self._lock:
            return self._expire_locked(camera_id, now_pts_ms)

    def _expire_locked(self, camera_id: str, now_pts_ms: int) -> list[BestShot]:
        camera = self._by_camera.get(camera_id)
        if not camera:
            return []
        stale = [
            track_id
            for track_id, candidate in camera.items()
            if now_pts_ms - candidate.last_pts_ms > self.idle_flush_pts_ms
        ]
        return self._take(camera, stale)

    def end_session(self, camera_id: str) -> list[BestShot]:
        """Flush everything held for one camera. Called at a scene cut and at a reconnect."""
        with self._lock:
            self._last_pts.pop(camera_id, None)
            return self._drain(self._by_camera.get(camera_id) or {})

    def flush_all(self) -> list[BestShot]:
        """Flush every camera. Called once when the run ends, so nothing is silently lost."""
        with self._lock:
            out: list[BestShot] = []
            for camera in self._by_camera.values():
                out.extend(self._drain(camera))
            self._last_pts.clear()
            return out

    def _drain(self, camera: dict[int, _Candidate]) -> list[BestShot]:
        return self._take(camera, list(camera.keys()))

    def _take(self, camera: dict[int, _Candidate], track_ids: Iterable[int]) -> list[BestShot]:
        out: list[BestShot] = []
        for track_id in track_ids:
            candidate = camera.pop(track_id, None)
            if candidate is None:
                continue
            if not candidate.shot.crop_jpeg:
                # No encodable crop means no evidence to store. Counted, never quietly forgotten:
                # a best shot that produced no object is the difference between the object count
                # and the best-shot count, and an unexplained gap there looks like a storage bug.
                self.stats.dropped_no_crop += 1
                continue
            self.stats.flushed += 1
            out.append(candidate.shot)
        return out

    @property
    def pending(self) -> int:
        return sum(len(camera) for camera in self._by_camera.values())


@dataclass
class AttributeStats:
    """What the attribute stage did over a run. Every field is reported, including the failures."""

    crops_read: int = 0
    color_reads: int = 0
    low_confidence: int = 0
    by_color: dict[str, int] = field(default_factory=dict)

    def record(self, read: ColorRead) -> None:
        self.color_reads += 1
        if read.low_confidence:
            self.low_confidence += 1
        self.by_color[read.name] = self.by_color.get(read.name, 0) + 1

    @property
    def low_confidence_rate(self) -> float:
        return round(self.low_confidence / self.color_reads, 4) if self.color_reads else 0.0
