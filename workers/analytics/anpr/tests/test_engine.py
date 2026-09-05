"""The ANPR stage as the pipeline uses it.

The plate detector and the recogniser are substituted here, on purpose: what these tests are about
is the **aggregation** — one row per track, never across a scene cut, the crop written only for the
best shot, the budget bounded. Those are properties of this file's logic, and running two ONNX
models to assert them would make the tests slow without making them stricter. The models are
exercised for real in `test_ocr.py`, `test_rectify.py`, and against the sandbox by
`workers.analytics.eval_anpr`.
"""

from __future__ import annotations

import numpy as np
import pytest

from workers.analytics.anpr.crops import LocalCropStore, crop_key
from workers.analytics.anpr.engine import AnprEngine, crop_with_padding
from workers.analytics.anpr.ocr import OcrRead
from workers.analytics.anpr.plates import PlateBox
from workers.analytics.anpr.thresholds import ANPR_DEFAULTS
from workers.analytics.track import TrackedDetection

TS = "2026-09-05T04:30:00Z"


class FakePlateDetector:
    """Returns one plate box of a fixed size, and counts how often it was asked."""

    model = "fake-plate-detector"

    def __init__(self, width: float = 48.0, height: float = 16.0, found: bool = True) -> None:
        self.width, self.height, self.found = width, height, found
        self.calls = 0

        class _Stats:
            @staticmethod
            def percentile(_p: float) -> float | None:
                return 0.0

        self.stats = _Stats()

    def detect(self, image: np.ndarray) -> list[PlateBox]:
        self.calls += 1
        if not self.found:
            return []
        return [PlateBox(x=4.0, y=4.0, w=self.width, h=self.height, confidence=0.9)]


class ScriptedOcr:
    """Returns the next scripted read on every call, and counts calls. AC 1's instrument."""

    name = "scripted"
    model_name = "scripted"

    def __init__(self, texts: list[str], confidence: float = 0.8) -> None:
        self.texts = texts
        self.confidence = confidence
        self.calls = 0

        class _Stats:
            @staticmethod
            def percentile(_p: float) -> float | None:
                return 0.0

        self.stats = _Stats()

    def read(self, plate_image: np.ndarray) -> OcrRead | None:  # noqa: ARG002
        text = self.texts[min(self.calls, len(self.texts) - 1)]
        self.calls += 1
        if not text:
            return None
        return OcrRead(
            text=text,
            confidence=self.confidence,
            char_confidences=tuple([self.confidence] * len(text)),
            backend=self.name,
        )


def frame(width: int = 640, height: int = 480) -> np.ndarray:
    """A textured frame — a flat one would make every Laplacian variance identical."""
    return np.random.default_rng(11).integers(0, 255, (height, width, 3), dtype=np.uint8)


def tracked(track_id: int, *, w: float = 160.0, h: float = 120.0) -> TrackedDetection:
    return TrackedDetection(
        track_id=track_id,
        session_index=track_id // 100_000,
        tracker_id=track_id % 100_000,
        x=40.0,
        y=40.0,
        w=w,
        h=h,
        confidence=0.9,
        vehicle_class="car",
    )


def engine(ocr: ScriptedOcr, plates: FakePlateDetector, store=None, **kwargs) -> AnprEngine:
    return AnprEngine(plates, ocr, store, ANPR_DEFAULTS, **kwargs)


def test_a_track_emits_exactly_one_plate_read_however_long_it_lives() -> None:
    """"One `plate_reads` row per track (best)" — enforced at the source, not deduplicated later."""
    ocr = ScriptedOcr(["GJ01AB1234"])
    anpr = engine(ocr, FakePlateDetector())

    emissions = []
    for _ in range(20):
        emissions.append(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)
        )

    emitted = [e for e in emissions if e]
    assert len(emitted) == 1
    assert emitted[0][7]["rawText"] == "GJ01AB1234"
    assert emitted[0][7]["isBestShot"] is True
    assert anpr.stats.votes_emitted == 1


def test_best_shot_ocrs_the_top_n_frames_not_every_frame() -> None:
    """AC 1's efficiency half, at the mechanism level: OCR calls are bounded by N, not by frames."""
    ocr = ScriptedOcr(["GJ01AB1234"])
    anpr = engine(ocr, FakePlateDetector())

    for _ in range(20):
        anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)

    assert ocr.calls == ANPR_DEFAULTS.best_shot_top_n


def test_every_frame_mode_ocrs_every_examined_frame() -> None:
    """The control arm has to actually cost more, or the comparison in AC 1 proves nothing."""
    ocr = ScriptedOcr(["GJ01AB1234"])
    anpr = engine(ocr, FakePlateDetector(), every_frame=True)

    for _ in range(20):
        anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)

    assert ocr.calls > ANPR_DEFAULTS.best_shot_top_n


def test_two_tracks_across_a_scene_cut_are_never_voted_together() -> None:
    """The loop point. `track_id` carries the session, so the buffers cannot merge.

    D1-09 measured raw ByteTrack ids 1 and 2 being reused across sessions 6 and 9 on `cam03` inside
    one run. Before the cut this vehicle is track 7; after it, a *different* vehicle is also
    tracker id 7 — but in session 1, so `track_id` 100_007. Two rows, two plates, no bleed.
    """
    ocr = ScriptedOcr(["GJ01AB1234"] * 3 + ["MH12CD5678"] * 3)
    anpr = engine(ocr, FakePlateDetector())

    before = {}
    for _ in range(6):
        before.update(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)
        )
    after = {}
    for _ in range(6):
        after.update(
            anpr.observe(
                frame(), [tracked(100_007)], camera_external_id="cam06", ts=TS, frame_pts_ms=9_000
            )
        )

    assert before[7]["rawText"] == "GJ01AB1234"
    assert after[100_007]["rawText"] == "MH12CD5678"


def test_the_same_track_id_on_two_cameras_is_two_vehicles() -> None:
    """`track_id` is unique per camera per session, never estate-wide."""
    ocr = ScriptedOcr(["GJ01AB1234"] * 3 + ["MH12CD5678"] * 3)
    anpr = engine(ocr, FakePlateDetector())

    first = {}
    for _ in range(6):
        first.update(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)
        )
    second = {}
    for _ in range(6):
        second.update(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam21", ts=TS, frame_pts_ms=0)
        )

    assert first[7]["rawText"] != second[7]["rawText"]
    assert anpr.stats.tracks_seen == 2


def test_a_vehicle_too_small_to_hold_a_plate_costs_no_plate_detector_call() -> None:
    plates = FakePlateDetector()
    anpr = engine(ScriptedOcr(["GJ01AB1234"]), plates)

    for _ in range(5):
        anpr.observe(
            frame(), [tracked(7, w=20.0, h=16.0)],
            camera_external_id="cam06", ts=TS, frame_pts_ms=0,
        )

    assert plates.calls == 0
    assert anpr.stats.vehicles_too_small == 5


def test_a_plate_below_the_width_floor_is_counted_not_read() -> None:
    """Under ~20 px there is less than a pixel per stroke; any string returned is an invention."""
    plates = FakePlateDetector(width=8.0, height=4.0)
    ocr = ScriptedOcr(["INVENTED12"])
    anpr = engine(ocr, plates)

    for _ in range(ANPR_DEFAULTS.max_examine_per_track + 2):
        anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)

    assert ocr.calls == 0
    assert anpr.stats.plates_too_narrow > 0
    assert anpr.stats.votes_emitted == 0


def test_a_low_confidence_vote_is_dropped_and_counted_rather_than_written() -> None:
    ocr = ScriptedOcr(["GJ01AB1234"], confidence=0.05)
    anpr = engine(ocr, FakePlateDetector())

    emitted: dict[int, dict] = {}
    for _ in range(6):
        emitted.update(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)
        )

    assert emitted == {}
    assert anpr.stats.votes_below_floor == 1


def test_a_non_vehicle_class_is_never_examined() -> None:
    """A pedestrian has no plate. D1-09 keeps `person` because proximity is evidence, not identity."""
    plates = FakePlateDetector()
    anpr = engine(ScriptedOcr(["GJ01AB1234"]), plates)
    person = TrackedDetection(
        track_id=3, session_index=0, tracker_id=3, x=10, y=10, w=80, h=180,
        confidence=0.9, vehicle_class="person",
    )

    anpr.observe(frame(), [person], camera_external_id="cam06", ts=TS, frame_pts_ms=0)

    assert plates.calls == 0
    assert anpr.stats.tracks_seen == 0


def test_the_crop_is_written_once_per_track_under_d2_02s_key(tmp_path) -> None:
    """Crops only for best shots — D2-02's AC, enforced here because here is where they are made."""
    store = LocalCropStore(tmp_path)
    anpr = engine(ScriptedOcr(["GJ01AB1234"]), FakePlateDetector(), store)

    emitted: dict[int, dict] = {}
    for _ in range(20):
        emitted.update(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)
        )

    assert store.written == 1
    expected = tmp_path / crop_key("cam06", "2026-09-05", 7)
    assert expected.exists()
    assert emitted[7]["cropUri"] == expected.resolve().as_uri()


def test_a_track_that_never_shows_a_plate_produces_no_row() -> None:
    plates = FakePlateDetector(found=False)
    anpr = engine(ScriptedOcr(["GJ01AB1234"]), plates)

    emitted: dict[int, dict] = {}
    for _ in range(ANPR_DEFAULTS.max_examine_per_track + 4):
        emitted.update(
            anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)
        )

    assert emitted == {}
    assert anpr.stats.votes_emitted == 0
    # The plate detector still ran — the budget bounds it, so the cost is known, not unbounded.
    assert plates.calls == ANPR_DEFAULTS.max_examine_per_track


def test_tracks_still_in_frame_at_the_deadline_are_counted_not_invented() -> None:
    """A flushed vote has no sighting to attach to. Counting is honest; inventing one is not."""
    anpr = engine(ScriptedOcr(["GJ01AB1234"]), FakePlateDetector())
    anpr.observe(frame(), [tracked(7)], camera_external_id="cam06", ts=TS, frame_pts_ms=0)

    assert anpr.tracks_unemitted == 1


@pytest.mark.parametrize(
    ("x", "y", "w", "h"),
    [(0.0, 0.0, 40.0, 40.0), (600.0, 440.0, 100.0, 100.0), (-5.0, -5.0, 30.0, 30.0)],
)
def test_crop_with_padding_stays_inside_the_frame(x: float, y: float, w: float, h: float) -> None:
    """A box on the frame edge must clamp, not wrap — numpy slicing wraps silently on negatives."""
    image = frame(640, 480)
    crop, x0, y0 = crop_with_padding(image, x, y, w, h, 0.2)

    assert crop.size > 0
    assert x0 >= 0
    assert y0 >= 0
    assert y0 + crop.shape[0] <= image.shape[0]
    assert x0 + crop.shape[1] <= image.shape[1]
