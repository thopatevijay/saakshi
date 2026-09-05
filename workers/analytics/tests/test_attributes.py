"""Vehicle attributes and best-shot selection (D2-02).

Three kinds of test, in increasing order of how much they prove:

1. **Synthetic swatches** for the palette. Ten colours, each a plate of known HSV, so the mapping
   is falsifiable without a camera. This is the fixture test AC 2 asks for.
2. **Refusals.** A crop the classifier cannot separate must come back `unknown` with the flag set —
   never the runner-up quietly promoted. AC 3 is about what the classifier *declines* to say.
3. **The selector against the real database.** 28,438 sightings measured off this estate by D1-09
   go through the real `BestShotSelector`, and exactly one best shot per track session must come
   out. That is the count property the whole storage argument rests on, tested on real data rather
   than on a fixture shaped to agree with it.
"""

from __future__ import annotations

import os
from collections import defaultdict

import cv2
import numpy as np
import pytest

from workers.analytics.attributes import (
    COLOR_CONFIDENCE_MIN,
    PALETTE,
    BestShot,
    BestShotSelector,
    ColorRead,
    best_shot_score,
    body_type,
    classify_color,
    crop_box,
    encode_jpeg,
    sharpness,
)


# ── helpers ─────────────────────────────────────────────────────────────────────────────────────


def plate(bgr: tuple[int, int, int], size: int = 80) -> np.ndarray:
    """A solid patch of one colour, large enough to clear `MIN_VOTING_PIXELS` after the inset."""
    img = np.zeros((size, size, 3), dtype=np.uint8)
    img[:, :] = bgr
    return img


def noisy_plate(bgr: tuple[int, int, int], sigma: float = 12.0, size: int = 80) -> np.ndarray:
    """A patch with sensor-like noise. A classifier that only works on flat colour is not one."""
    rng = np.random.default_rng(7)
    base = plate(bgr, size).astype(np.float32)
    return np.clip(base + rng.normal(0.0, sigma, base.shape), 0, 255).astype(np.uint8)


def shot(
    camera: str = "cam01",
    track: int = 100_001,
    pts: int = 1_000,
    score: float = 0.5,
    crop: bytes = b"\xff\xd8jpeg",
) -> BestShot:
    return BestShot(
        camera_id=camera,
        track_id=track,
        ts="2026-09-05T06:00:00Z",
        frame_pts_ms=pts,
        vehicle_class="car",
        det_confidence=0.9,
        bbox={"x": 10.0, "y": 10.0, "w": 100.0, "h": 80.0},
        score=score,
        focus=180.0,
        color=ColorRead("white", 0.7, False, 0.05),
        body="car",
        crop_jpeg=crop,
    )


# ── AC 2 · the palette, ten colours ─────────────────────────────────────────────────────────────

# BGR, because OpenCV. Deliberately not the extreme corner of each hue: a classifier that only
# recognises pure #FF0000 recognises nothing on a road.
SWATCHES: dict[str, tuple[int, int, int]] = {
    "white": (238, 240, 242),
    "silver": (168, 170, 172),
    "grey": (95, 96, 98),
    "black": (22, 22, 24),
    "red": (30, 28, 190),
    "blue": (185, 70, 30),
    "yellow": (30, 205, 220),
    "green": (60, 150, 45),
    "brown": (35, 62, 105),
    "other": (150, 40, 160),  # magenta — a real colour with no palette entry of its own
}


@pytest.mark.parametrize("expected,bgr", sorted(SWATCHES.items()))
def test_palette_maps_every_documented_colour(expected: str, bgr: tuple[int, int, int]) -> None:
    """AC 2 — ten colours, well above the >= 6 the ticket asks for, each named correctly."""
    read = classify_color(plate(bgr))
    assert read.name == expected, f"{expected} swatch read as {read.name} ({read.confidence})"
    assert not read.low_confidence
    assert read.confidence >= COLOR_CONFIDENCE_MIN


@pytest.mark.parametrize("expected,bgr", sorted(SWATCHES.items()))
def test_palette_survives_sensor_noise(expected: str, bgr: tuple[int, int, int]) -> None:
    """The same ten under noise. A flat-colour-only classifier is not a classifier."""
    assert classify_color(noisy_plate(bgr)).name == expected


def test_every_palette_name_is_reachable() -> None:
    """The documented palette and the reachable palette are the same set.

    A name in `PALETTE` that no input can produce is documentation that lies; a name the classifier
    can emit that is not in `PALETTE` breaks every consumer that filters on it.
    """
    produced = {classify_color(plate(bgr)).name for bgr in SWATCHES.values()}
    assert produced == set(PALETTE)


# ── AC 3 · confidence, and the refusal ──────────────────────────────────────────────────────────


def test_confidence_is_always_emitted() -> None:
    read = classify_color(plate(SWATCHES["red"]))
    assert 0.0 <= read.confidence <= 1.0
    assert read.confidence > 0.0
    assert isinstance(read.low_confidence, bool)


def test_ambiguous_crop_is_refused_not_guessed() -> None:
    """Half red, half blue: two strong candidates and no winner.

    The classifier must say `unknown` and set the flag. Promoting the 51% side would produce a
    confident-looking colour on exactly the crops where colour means least.
    """
    img = np.zeros((80, 80, 3), dtype=np.uint8)
    img[:, :40] = SWATCHES["red"]
    img[:, 40:] = SWATCHES["blue"]
    read = classify_color(img)
    assert read.name == "unknown"
    assert read.low_confidence
    assert read.runner_up is not None
    # The evidence is retained even though the read was refused: a near-miss must be inspectable.
    assert read.confidence > 0.0


def test_night_frame_drives_chroma_share_to_zero() -> None:
    """A dark, desaturated crop — the estate's night failure mode, stated rather than hidden.

    It still produces an answer (black), and `chroma_share` records *why* colour is unavailable
    there. This is the number that belongs in the report instead of a flattering aggregate.
    """
    read = classify_color(noisy_plate((18, 18, 20), sigma=6.0))
    assert read.chroma_share < 0.05
    assert read.name == "black"


def test_tiny_crop_is_refused() -> None:
    """A 6x6 box carries no colour. Refused, not averaged into a confident grey."""
    read = classify_color(plate(SWATCHES["blue"], size=6))
    assert read.name == "unknown"
    assert read.low_confidence


def test_empty_crop_is_refused() -> None:
    assert classify_color(np.empty((0, 0, 3), dtype=np.uint8)).name == "unknown"


# ── body type ───────────────────────────────────────────────────────────────────────────────────


def test_body_type_is_a_rename_of_the_detector_class() -> None:
    assert body_type("car") == "car"
    assert body_type("truck") == "truck"
    assert body_type("bus") == "bus"
    assert body_type("motorcycle") == "two_wheeler"
    assert body_type("bicycle") == "two_wheeler"


def test_body_type_declines_for_a_pedestrian() -> None:
    """`person` is kept as a sighting class but has no body type. Writing one would put pedestrians
    into vehicle attribute queries."""
    assert body_type("person") is None
    assert body_type("unknown") is None


def test_auto_rickshaw_is_mapped_but_not_invented() -> None:
    """The mapping exists for a rickshaw-capable detector; COCO cannot produce the class today, so
    nothing in the pipeline emits it. Documented here so the gap is visible rather than assumed."""
    from workers.analytics.detect import COCO_TO_VEHICLE_CLASS

    assert body_type("auto_rickshaw") == "auto_rickshaw"
    assert "auto_rickshaw" not in COCO_TO_VEHICLE_CLASS.values()


# ── crops and scoring ───────────────────────────────────────────────────────────────────────────


def test_crop_box_pads_and_clips_to_the_frame() -> None:
    frame = np.zeros((200, 300, 3), dtype=np.uint8)
    inner = crop_box(frame, 10, 10, 100, 80)
    assert inner.shape[0] > 80 and inner.shape[1] > 100  # padded
    edge = crop_box(frame, 0, 0, 300, 200)
    assert edge.shape[:2] == (200, 300)  # clipped, never out of bounds


def test_sharper_crop_scores_higher() -> None:
    sharp = noisy_plate((120, 120, 120), sigma=40.0)
    blurred = cv2.GaussianBlur(sharp, (15, 15), 0)
    assert sharpness(sharp) > sharpness(blurred)


def test_best_shot_score_prefers_big_sharp_central_boxes() -> None:
    common = {"det_confidence": 0.9, "frame_width": 1920, "frame_height": 1080}
    big = best_shot_score(w=200, h=160, focus=300, x=800, y=400, **common)
    small = best_shot_score(w=40, h=30, focus=300, x=800, y=400, **common)
    blurry = best_shot_score(w=200, h=160, focus=10, x=800, y=400, **common)
    clipped = best_shot_score(w=200, h=160, focus=300, x=0, y=400, **common)
    assert big > small
    assert big > blurry
    assert big > clipped, "a vehicle half out of frame is poor evidence however large"


def test_encode_jpeg_round_trips() -> None:
    data = encode_jpeg(plate(SWATCHES["red"]))
    assert data[:2] == b"\xff\xd8"  # JPEG SOI
    decoded = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert decoded.shape == (80, 80, 3)


# ── AC 4 · one crop per track session, and no more ───────────────────────────────────────────────


def test_selector_keeps_only_the_highest_scoring_observation() -> None:
    selector = BestShotSelector()
    assert selector.offer(shot(pts=1000, score=0.2)) == []
    assert selector.offer(shot(pts=1100, score=0.8)) == []
    assert selector.offer(shot(pts=1200, score=0.4)) == []
    out = selector.flush_all()
    assert len(out) == 1
    assert out[0].score == 0.8
    assert out[0].observations == 3, "the compression ratio is reported, not thrown away"


def test_selector_flushes_on_pts_idle_not_wall_time() -> None:
    """The expiry clock is stream time. A wall clock would fire at the wrong moment on a throttled
    gateway, where a 3-second PTS gap can take 30 seconds to arrive."""
    selector = BestShotSelector(idle_flush_pts_ms=3_000)
    selector.offer(shot(track=100_001, pts=1_000))
    assert selector.offer(shot(track=100_002, pts=2_000)) == []
    ready = selector.offer(shot(track=100_002, pts=9_000))
    assert [s.track_id for s in ready] == [100_001]


def test_selector_never_merges_across_a_scene_cut() -> None:
    """D1-09's measured constraint: raw ByteTrack ids are reused across sessions.

    Two sessions, the same raw tracker id 1, on the same camera. They are two vehicles and must
    produce two best shots — a selector keyed on the raw id would produce one.
    """
    selector = BestShotSelector()
    selector.offer(shot(track=6 * 100_000 + 1, pts=1_000, score=0.3))
    before_cut = selector.end_session("cam01")
    selector.offer(shot(track=9 * 100_000 + 1, pts=1_100, score=0.9))
    after_cut = selector.flush_all()

    assert [s.track_id for s in before_cut] == [600_001]
    assert [s.track_id for s in after_cut] == [900_001]
    assert before_cut[0].score == 0.3, "the pre-cut vehicle kept its own best shot"


def test_selector_flushes_when_pts_rewinds() -> None:
    """A reconnect replays a buffered GOP, so PTS goes backwards. Nothing may straddle that."""
    selector = BestShotSelector()
    selector.offer(shot(track=100_001, pts=50_000))
    ready = selector.offer(shot(track=200_001, pts=400))
    assert [s.track_id for s in ready] == [100_001]
    assert selector.stats.pts_rewind_flushes == 1


def test_selector_does_not_treat_a_loop_as_a_permanent_rewind() -> None:
    """The regression that a running high-water mark caused, measured on the replay run.

    A looping feed restarts its PTS near zero on every reconnect. Tracking the *highest* PTS ever
    seen meant every frame of every later loop looked like a rewind, and 856 real track sessions
    flushed as 19,367 one-observation candidates — one crop per 1.3 sightings, exactly the
    unbounded-storage shape this ticket refuses. Only the *first* frame after the jump may count.
    """
    selector = BestShotSelector()
    for pts in range(1_000, 24_000, 1_000):
        selector.offer(shot(track=100_001, pts=pts))
    selector.end_session("cam01")

    for pts in range(1_000, 24_000, 1_000):  # the next loop, PTS restarted
        selector.offer(shot(track=200_001, pts=pts))
    out = selector.flush_all()

    assert selector.stats.pts_rewind_flushes == 0, "an explicit end_session already handled the loop"
    assert len(out) == 1
    assert out[0].observations == 23, "every observation of the second loop belonged to one track"


def test_selector_memory_is_bounded() -> None:
    """`no unbounded memory over a 20-minute run` has to be true of this map too."""
    selector = BestShotSelector(max_tracks_per_camera=8)
    flushed = 0
    for index in range(40):
        flushed += len(selector.offer(shot(track=100_000 + index, pts=1_000 + index)))
    assert selector.pending <= 8
    assert flushed >= 32
    assert selector.stats.capacity_flushes > 0


def test_selector_drops_a_candidate_with_no_crop_and_counts_it() -> None:
    """An unencodable crop is no evidence. Counted, so the object/best-shot gap is explainable."""
    selector = BestShotSelector()
    selector.offer(shot(crop=b""))
    assert selector.flush_all() == []
    assert selector.stats.dropped_no_crop == 1


# ── AC 4 / gate G1 · the count property, on the real 28,438 rows ─────────────────────────────────

REQUIRES_DB = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set — the real-data count property needs the seeded database",
)


@REQUIRES_DB
def test_best_shot_count_matches_track_sessions_on_real_sightings() -> None:
    """The whole storage argument, measured on real detections rather than on a fixture.

    Every seeded sighting is offered to the real selector in PTS order. What must come out is one
    best shot per `(camera, session-qualified track_id)` — not one per sighting, which is the
    17 TB/year design PROJECT.md §9 refuses.
    """
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        rows = conn.execute(
            """
            select camera_id::text as camera_id, track_id, frame_pts_ms, ts,
                   class, det_confidence, bbox
              from sightings
             order by camera_id, frame_pts_ms, track_id
            """
        ).fetchall()

    if not rows:
        pytest.skip("no sightings in this database")

    # Offline replay of a finished table, so the idle window is disabled: there is no memory to
    # bound and no live stream whose tracks could go stale. With it disabled the property is exact —
    # one best shot per track session. The live-window behaviour is measured separately below.
    selector = BestShotSelector(idle_flush_pts_ms=10**12)
    emitted: list[BestShot] = []
    for row in rows:
        emitted.extend(
            selector.offer(
                BestShot(
                    camera_id=row["camera_id"],
                    track_id=int(row["track_id"]),
                    ts=row["ts"].isoformat(),
                    frame_pts_ms=int(row["frame_pts_ms"]),
                    vehicle_class=str(row["class"]),
                    det_confidence=float(row["det_confidence"]),
                    bbox=dict(row["bbox"]),
                    # No frame source for a historical row, so the score is the part of it that
                    # survives without pixels: detector confidence times apparent size. The colour
                    # is NOT invented — that is exactly the claim this project refuses to make.
                    score=float(row["det_confidence"]) * float(row["bbox"]["w"] * row["bbox"]["h"]) ** 0.5,
                    focus=0.0,
                    color=ColorRead("unknown", 0.0, True, 0.0),
                    body=body_type(str(row["class"])),
                    crop_jpeg=b"\xff\xd8placeholder",
                )
            )
        )
    emitted.extend(selector.flush_all())

    sessions = {(row["camera_id"], int(row["track_id"])) for row in rows}
    assert len(emitted) == len(sessions), (
        f"{len(rows)} sightings across {len(sessions)} track sessions produced "
        f"{len(emitted)} best shots"
    )
    assert len(emitted) < len(rows) / 10, "a crop per sighting is the design PROJECT.md §9 refuses"

    # One per session, and each one really is that session's highest-scoring observation.
    per_session: dict[tuple[str, int], list[float]] = defaultdict(list)
    for row in rows:
        per_session[(row["camera_id"], int(row["track_id"]))].append(
            float(row["det_confidence"]) * float(row["bbox"]["w"] * row["bbox"]["h"]) ** 0.5
        )
    for best in emitted:
        assert best.score == pytest.approx(max(per_session[(best.camera_id, best.track_id)]))


@REQUIRES_DB
def test_live_idle_window_costs_a_measured_handful_of_extra_crops() -> None:
    """The same real rows through the *production* selector, idle window and all.

    A track that goes unseen for longer than `TRACK_IDLE_FLUSH_PTS_MS` of PTS is flushed and, if it
    reappears, is re-acquired — which costs a second crop. That is a real cost and it is measured
    here rather than assumed to be zero: a live worker cannot hold a candidate for a vehicle that
    may never come back. The bound is deliberately tight; if a change made re-acquisition common,
    the object count would drift away from the session count and this test would say so.
    """
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        rows = conn.execute(
            """
            select camera_id::text as camera_id, track_id, frame_pts_ms, ts,
                   class, det_confidence, bbox
              from sightings
             order by camera_id, frame_pts_ms, track_id
            """
        ).fetchall()

    if not rows:
        pytest.skip("no sightings in this database")

    selector = BestShotSelector()
    emitted = 0
    for row in rows:
        emitted += len(
            selector.offer(
                BestShot(
                    camera_id=row["camera_id"],
                    track_id=int(row["track_id"]),
                    ts=row["ts"].isoformat(),
                    frame_pts_ms=int(row["frame_pts_ms"]),
                    vehicle_class=str(row["class"]),
                    det_confidence=float(row["det_confidence"]),
                    bbox=dict(row["bbox"]),
                    score=float(row["det_confidence"]),
                    focus=0.0,
                    color=ColorRead("unknown", 0.0, True, 0.0),
                    body=body_type(str(row["class"])),
                    crop_jpeg=b"\xff\xd8placeholder",
                )
            )
        )
    emitted += len(selector.flush_all())

    sessions = len({(row["camera_id"], int(row["track_id"])) for row in rows})
    assert emitted >= sessions
    assert emitted <= sessions * 1.02, (
        f"{emitted} crops for {sessions} track sessions — re-acquisition is costing more than 2%"
    )
