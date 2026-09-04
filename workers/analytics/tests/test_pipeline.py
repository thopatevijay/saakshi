"""The frame loop itself, over real decoded files.

The detector is stubbed here and only here. That is deliberate: these tests are about the *pipeline*
— PTS timing, the identity boundary at a scene cut, decoder warnings, two codecs at two resolutions
in one run, handle hygiene — and a real YOLO pass over a synthetic test pattern detects nothing, so
a real model would make every one of these assertions vacuous. What YOLO actually finds is measured
against the live estate in the ticket's gate run, not asserted here.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest

from workers.analytics.bus import CollectingSink
from workers.analytics.capabilities import CameraCapabilities
from workers.analytics.detect import Detection
from workers.analytics.pipeline import CameraPipeline, CameraSource, is_retryable
from workers.analytics.thresholds import AnalyticsThresholds, DEFAULTS

from .conftest import requires_ffmpeg


class StubDetector:
    """One car, in the same place on every frame — so any id change is the pipeline's doing.

    A moving box would let ByteTrack lose the track for its own reasons, and the test would then be
    measuring the tracker rather than the session boundary this ticket owns.
    """

    def __init__(self) -> None:
        self.calls = 0
        self.imgsz_seen: list[int] = []
        self.shapes_seen: list[tuple[int, int]] = []

    def infer(self, frame, capabilities: CameraCapabilities) -> list[Detection]:  # noqa: ANN001
        from workers.analytics.capabilities import inference_size

        self.calls += 1
        self.imgsz_seen.append(inference_size(capabilities))
        self.shapes_seen.append((capabilities.width, capabilities.height))
        return [Detection(x=100.0, y=100.0, w=80.0, h=60.0, confidence=0.9, vehicle_class="car")]


#: Burst discard off. These clips are four seconds long, so discarding the first two would leave the
#: assertions with almost nothing to stand on. The burst rule is exercised against the live gateway,
#: where a connect burst actually exists.
NO_BURST = AnalyticsThresholds(burst_discard_s=0.0)


def run_file(
    path: Path,
    *,
    thresholds: AnalyticsThresholds = NO_BURST,
    detector: StubDetector | None = None,
    sink: CollectingSink | None = None,
    external_id: str = "fixture",
) -> tuple[CameraPipeline, CollectingSink, StubDetector]:
    engine = detector or StubDetector()
    out = sink or CollectingSink()
    pipeline = CameraPipeline(
        CameraSource(external_id=external_id, url=str(path)),
        engine,
        out,
        thresholds=thresholds,
        jitter=0.0,
    )
    pipeline.run(threading.Event(), None, max_sessions=1)
    return pipeline, out, engine


# ── AC 2: PTS-derived timing ────────────────────────────────────────────────────────────────────

@requires_ffmpeg
def test_every_sighting_carries_a_pts_derived_timestamp(clips: dict[str, Path]) -> None:
    _, sink, _ = run_file(clips["h264_small"])
    assert sink.sightings

    pts_values = [s["framePtsMs"] for s in sink.sightings]
    assert pts_values == sorted(pts_values)
    assert min(pts_values) >= 0
    # 4 seconds of clip: the PTS span is the stream's, not the wall time we took to decode it.
    assert max(pts_values) <= 4_100

    first, last = sink.sightings[0], sink.sightings[-1]
    assert first["ts"].endswith("Z")
    # `ts - epoch` moves in lockstep with PTS, which is the property that would break the instant
    # anything used arrival time: decoding is far faster than real time on a local file.
    ts_delta_ms = (
        time.mktime(time.strptime(last["ts"][:19], "%Y-%m-%dT%H:%M:%S"))
        - time.mktime(time.strptime(first["ts"][:19], "%Y-%m-%dT%H:%M:%S"))
    ) * 1000
    pts_delta_ms = last["framePtsMs"] - first["framePtsMs"]
    assert abs(ts_delta_ms - pts_delta_ms) <= 1_100


@requires_ffmpeg
def test_a_sighting_carries_the_camera_id_bbox_and_confidence(clips: dict[str, Path]) -> None:
    _, sink, _ = run_file(clips["h264_small"], external_id="cam99")
    sighting = sink.sightings[0]
    assert sighting["cameraId"] == "cam99"
    assert sighting["class"] == "car"
    assert 0.0 <= sighting["detConfidence"] <= 1.0
    assert set(sighting["bbox"]) == {"x", "y", "w", "h"}
    assert sighting["bbox"]["w"] > 0 and sighting["bbox"]["h"] > 0


# ── AC 3: the identity boundary at the loop point ───────────────────────────────────────────────

@requires_ffmpeg
def test_track_ids_do_not_bleed_across_the_loop_point_scene_cut(clips: dict[str, Path]) -> None:
    """The AC, stated as the query D2-08 would run: no id appears on both sides of the cut."""
    pipeline, sink, _ = run_file(clips["scene_cut"])

    assert pipeline.stats.scene_cuts >= 1, "the fixture's cut was not detected at all"
    assert sink.sightings, "no sightings to compare across the cut"

    # The cut is at the concat boundary, two seconds in.
    before = {s["trackId"] for s in sink.sightings if s["framePtsMs"] < 2_000}
    after = {s["trackId"] for s in sink.sightings if s["framePtsMs"] > 2_100}

    assert before, "nothing was tracked before the cut"
    assert after, "nothing was tracked after the cut"
    assert before.isdisjoint(after), f"identity bled across the cut: {before & after}"


@requires_ffmpeg
def test_track_ids_are_stable_within_a_camera_between_cuts(clips: dict[str, Path]) -> None:
    """The other half of the AC: reset *cleanly*, not constantly.

    A tracker that issued a new id every frame would trivially pass the disjointness test above.
    """
    _, sink, _ = run_file(clips["gentle"])
    ids = [s["trackId"] for s in sink.sightings]
    assert len(ids) >= 10
    assert len(set(ids)) == 1, f"a stationary car took {len(set(ids))} identities"


@requires_ffmpeg
def test_the_session_offset_puts_the_two_sides_of_a_cut_in_different_id_bands(
    clips: dict[str, Path],
) -> None:
    _, sink, _ = run_file(clips["scene_cut"])
    bands = {s["trackId"] // DEFAULTS.track_session_stride for s in sink.sightings}
    assert bands == {0, 1}


# ── AC 5: join-time decoder warnings are logged, not fatal ──────────────────────────────────────

@requires_ffmpeg
def test_decoder_warnings_are_counted_and_the_worker_keeps_going(clips: dict[str, Path]) -> None:
    """AC 5, in both halves: the complaints are *recorded*, and the run still produces sightings."""
    pipeline, sink, _ = run_file(clips["corrupt"])

    warnings_seen = pipeline.stats.benign_warnings + pipeline.stats.other_warnings
    assert warnings_seen > 0, "libav complained and nothing counted it"
    # `no frame!` and friends are in `BENIGN_DECODER_WARNINGS`, reused from the prober rather than
    # duplicated — two lists that drift is how one worker starts failing what the other tolerates.
    assert pipeline.stats.benign_warnings > 0
    assert pipeline.stats.frames_decoded > 0
    assert sink.sightings, "a warning was treated as fatal"


@requires_ffmpeg
def test_a_stream_that_ends_mid_frame_is_survivable(clips: dict[str, Path]) -> None:
    pipeline, sink, _ = run_file(clips["truncated"])
    assert pipeline.stats.frames_decoded > 0
    assert sink.sightings, "the decoder gave up on a stream it could still read"


@requires_ffmpeg
def test_benign_warnings_are_classified_using_the_probers_list_not_a_second_one(
    clips: dict[str, Path],
) -> None:
    """The join-time complaints D0-01 saw on *healthy* cameras must not read as failures."""
    from workers.analytics.pipeline import capture_decoder_warnings
    from workers.prober.probe import BENIGN_DECODER_WARNINGS
    import logging as stdlib_logging

    with capture_decoder_warnings() as collector:
        libav = stdlib_logging.getLogger("libav.h264")
        for message in BENIGN_DECODER_WARNINGS:
            libav.warning("%s", message)
        libav.warning("something nobody has seen before")

    assert collector.benign == len(BENIGN_DECODER_WARNINGS)
    assert collector.other == 1


def test_our_own_deadline_is_classified_as_retry_later_not_as_a_broken_camera() -> None:
    """D1-03 / #7: PyAV raises `ExitError` for a timeout, never `TimeoutError`.

    D1-05 caught only the obvious name and wrote down `cam06` — confirmed decodable by D0-01 — as a
    non-retryable failure after 60,067 ms. Our own deadline firing was recorded as the camera being
    broken.
    """
    import av.error

    assert is_retryable(av.error.ExitError(1, "Immediate exit requested")) is True
    assert is_retryable(av.error.TimeoutError(1, "timeout")) is True
    assert is_retryable(OSError("connection reset")) is True
    assert is_retryable(ValueError("a real bug in our code")) is False


# ── AC 6: mixed codecs and resolutions in one run ───────────────────────────────────────────────

@requires_ffmpeg
def test_h264_and_h265_at_different_resolutions_are_handled_in_one_run(
    clips: dict[str, Path],
) -> None:
    """One worker, one detector, two codecs, two resolutions, two inference shapes.

    Failure mode 7. The shared detector is the part that would break under a fixed-shape batch, so
    both cameras go through the *same* `StubDetector` instance and it records what each was given.
    """
    detector = StubDetector()
    sink = CollectingSink()
    stop = threading.Event()

    pipelines = [
        CameraPipeline(
            CameraSource(external_id=name, url=str(clips[key])),
            detector, sink, thresholds=NO_BURST, jitter=0.0,
        )
        for name, key in (("small-h264", "h264_small"), ("large-hevc", "hevc_720"))
    ]
    threads = [
        threading.Thread(target=p.run, args=(stop, None), kwargs={"max_sessions": 1})
        for p in pipelines
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    codecs = {p.stats.codec for p in pipelines}
    resolutions = {p.stats.resolution for p in pipelines}
    assert codecs == {"h264", "hevc"}
    assert resolutions == {"640x480", "1280x720"}

    # Both produced rows, and each got its own inference shape rather than one fixed batch.
    for pipeline in pipelines:
        assert pipeline.stats.sightings > 0, f"{pipeline.source.external_id} produced nothing"
    assert len(set(detector.imgsz_seen)) == 2
    # 640x480 infers at its own long edge; 1280x720 clamps to the 960 cap. Two shapes, one run.
    assert {p.stats.imgsz for p in pipelines} == {640, 960}


# ── AC 7: the gate reduces inference calls, measurably ──────────────────────────────────────────

@requires_ffmpeg
def test_the_run_reports_a_skip_ratio_and_it_reflects_the_content(clips: dict[str, Path]) -> None:
    static_pipeline, _, static_detector = run_file(clips["static"])
    moving_pipeline, _, moving_detector = run_file(clips["moving"])

    assert static_pipeline.stats.frames_considered > 0
    assert static_pipeline.stats.skip_ratio >= 0.9
    assert moving_pipeline.stats.skip_ratio <= 0.1
    # The saving is real work avoided, not just a counter.
    assert static_detector.calls < moving_detector.calls / 5


# ── AC 9: no leaked capture handles ─────────────────────────────────────────────────────────────

@pytest.mark.skipif(not Path("/dev/fd").exists(), reason="needs /dev/fd to count descriptors")
@requires_ffmpeg
def test_repeated_sessions_do_not_leak_file_descriptors(clips: dict[str, Path]) -> None:
    """Twenty connect/disconnect cycles must end where they started.

    At eight streams reconnecting on a throttled gateway, one descriptor leaked per reconnect
    exhausts the table and surfaces as *unrelated* cameras becoming unreachable — a failure that
    looks like the estate and is actually us.
    """
    def open_fds() -> int:
        return len(os.listdir("/dev/fd"))

    run_file(clips["h264_small"])  # warm-up: first open allocates caches that are not a leak
    baseline = open_fds()
    for _ in range(20):
        run_file(clips["h264_small"])
    assert open_fds() <= baseline + 2, f"{open_fds() - baseline} descriptors leaked over 20 sessions"
