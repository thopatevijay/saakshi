"""Integration tests: real H.264 files, decoded through the real probe path.

The unit tests prove the arithmetic. These prove the thing the arithmetic is attached to — that a
container is opened, decoded through PyAV, closed on every path, and turned into the same signals.
A `file://` URL exercises everything except the HTTP layer, which is the part a test cannot own.
"""

from __future__ import annotations

from pathlib import Path

import av
import pytest

from workers.prober import signals
from workers.prober.probe import BENIGN_DECODER_WARNINGS, probe_camera
from workers.prober.thresholds import DEFAULTS, Thresholds

from .conftest import requires_ffmpeg

# These clips are 6 s long, so the 30 s production window would just read the whole file. A short
# window with no burst discard keeps the fixtures small; the discard itself is proven exhaustively
# in test_signals.py, where it can be tested against exact frame counts.
SHORT = Thresholds(fps_window_s=4.0, burst_discard_s=0.0, min_fps_sample_frames=5)


def _probe(path: Path, thresholds: Thresholds = SHORT):
    return probe_camera(path.stem, str(path), thresholds=thresholds, max_wall_s=60.0)


@requires_ffmpeg
class TestDecodesRealVideo:
    def test_a_working_clip_produces_every_signal(self, clips: dict[str, Path]) -> None:
        """The gate's "no null values in any signal column for decodable cameras", in miniature."""
        result = _probe(clips["motion"])

        assert result.connectable is True
        assert result.decodable is True
        assert result.measured_fps == pytest.approx(25.0, abs=1.0)
        assert result.actual_resolution == "640x480"
        assert result.actual_codec == "h264"
        for signal in (result.blur_score, result.luma_mean, result.tamper_score):
            assert signal is not None
        assert result.night_usable is not None
        assert result.pts_drift_ms is not None

    def test_measured_fps_comes_from_pts_not_from_the_header(self, clips: dict[str, Path]) -> None:
        result = _probe(clips["motion"])
        fps = result.breakdown["fps"]
        assert fps["pts_span_s"] > 0
        assert fps["frames_counted"] >= SHORT.min_fps_sample_frames

    def test_declared_fps_divergence_is_recorded_against_the_real_stream(
        self, clips: dict[str, Path]
    ) -> None:
        """AC 3, end to end: a 25 fps clip whose owner declared 30."""
        result = probe_camera(
            "declared-30", str(clips["motion"]), declared_fps=30.0, thresholds=SHORT, max_wall_s=60.0
        )
        fps = result.breakdown["fps"]
        assert fps["declared"] == 30.0
        assert fps["diverged"] is True
        assert fps["divergence_fraction"] < 0


@requires_ffmpeg
class TestTamperAgainstRealVideo:
    def test_a_black_feed_scores_high(self, clips: dict[str, Path]) -> None:
        """AC 5. A real encoded black clip, not an array of zeros."""
        result = _probe(clips["black"])
        assert result.decodable is True
        assert result.tamper_score is not None
        assert result.tamper_score >= DEFAULTS.tamper_flag_min
        assert result.breakdown["tamper"]["flagged"] is True

    def test_a_normal_feed_does_not(self, clips: dict[str, Path]) -> None:
        result = _probe(clips["motion"])
        assert result.tamper_score is not None
        assert result.tamper_score < DEFAULTS.tamper_flag_min
        assert result.breakdown["tamper"]["flagged"] is False

    def test_the_loop_point_scene_cut_does_not(self, clips: dict[str, Path]) -> None:
        """AC 6, against a real cut: `testsrc` hard-cut to `smptebars`, encoded and re-demuxed.

        This is the shape of the sandbox's own loop point. The clip is 6 s and the window is 4 s, so
        the cut is genuinely inside the measured window rather than conveniently outside it.
        """
        result = _probe(clips["scene_cut"])

        assert result.decodable is True
        assert result.tamper_score is not None
        assert result.tamper_score < DEFAULTS.tamper_flag_min, (
            f"the loop point produced a false tamper flag: {result.breakdown['tamper']}"
        )


@requires_ffmpeg
class TestFailureModesAreReportedNotRaised:
    def test_a_truncated_stream_still_completes(self, clips: dict[str, Path]) -> None:
        """AC 7. Decoder complaints are logged; the probe finishes either way.

        `health()` reports, it never throws — a sweep of 80,000 cameras that aborts on the first
        malformed stream is not a sweep.
        """
        result = _probe(clips["truncated"])

        assert result.error is None or isinstance(result.error, str)
        assert "decoder_warnings_benign_count" in result.breakdown

    def test_a_missing_file_reports_rather_than_raises(self, tmp_path: Path) -> None:
        result = probe_camera("ghost", str(tmp_path / "nope.mp4"), thresholds=SHORT)

        assert result.connectable is False
        assert result.decodable is False
        assert result.error is not None

    def test_benign_join_warnings_are_classified_not_escalated(self) -> None:
        """The exact strings D0-01 saw on healthy cameras.

        Connecting mid-GOP means the first frames reference an IDR we never received. libav says so
        loudly and then recovers at the next keyframe. Treating that as a failure marks the whole
        estate broken.
        """
        assert "Error constructing the frame RPS" in BENIGN_DECODER_WARNINGS
        assert "Could not find ref with POC" in BENIGN_DECODER_WARNINGS


class _TrackingContainer:
    """Delegates to a real container and records whether `close()` was called.

    A proxy rather than a monkeypatched method: PyAV's `InputContainer` is a C extension type whose
    attributes are read-only, so `container.close = ...` raises. `__getattr__` forwards everything
    the probe actually touches — `streams`, `decode`, `duration`.
    """

    def __init__(self, inner: object, closed: list[object]) -> None:
        self._inner = inner
        self._closed = closed

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)

    def close(self) -> None:
        self._closed.append(self._inner)
        self._inner.close()


@requires_ffmpeg
class TestNoLeakedHandles:
    def test_every_container_is_closed_on_the_happy_path(
        self, clips: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """AC 8. At 80,000 cameras a handle leaked once per probe exhausts the descriptor table
        long before the sweep finishes, and it surfaces as *unrelated* cameras being unreachable."""
        opened: list[object] = []
        closed: list[object] = []
        real_open = av.open

        def tracking_open(*args: object, **kwargs: object) -> _TrackingContainer:
            inner = real_open(*args, **kwargs)
            opened.append(inner)
            return _TrackingContainer(inner, closed)

        monkeypatch.setattr(av, "open", tracking_open)

        result = _probe(clips["motion"])

        assert result.decodable is True
        assert len(opened) == 1
        assert len(closed) == 1

    def test_the_container_is_closed_even_when_decoding_raises(
        self, clips: dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The path that actually leaks in production: an exception part-way through decoding."""
        closed: list[object] = []
        real_open = av.open

        class _ExplodingContainer(_TrackingContainer):
            def decode(self, *args: object, **kwargs: object):
                raise av.error.InvalidDataError(1, "boom")

        def exploding_open(*args: object, **kwargs: object) -> _ExplodingContainer:
            return _ExplodingContainer(real_open(*args, **kwargs), closed)

        monkeypatch.setattr(av, "open", exploding_open)

        result = _probe(clips["motion"])

        assert len(closed) == 1, "the container must be closed even when decoding raises"
        assert result.decodable is False
        assert result.error is not None


class TestUnmeasurableIsDistinctFromUnhealthy:
    def test_a_timeout_is_marked_retryable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """D1-03's handoff, as a test: "D1-05 must treat TimeoutError as 'retry later', never as a
        health failure — that mistake was already made once here and it condemns healthy cameras."
        """

        def timing_out(*args: object, **kwargs: object):
            raise av.error.TimeoutError(110, "timed out")

        monkeypatch.setattr(av, "open", timing_out)

        result = probe_camera("slow", "file:///nowhere.mp4", thresholds=SHORT)

        assert result.retryable is True
        assert result.decodable is False
        assert "retry later" in result.breakdown["note"]

    def test_an_auth_failure_is_not_retryable_and_says_the_camera_may_be_fine(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def forbidden(*args: object, **kwargs: object):
            raise av.error.HTTPForbiddenError(403, "forbidden")

        monkeypatch.setattr(av, "open", forbidden)

        result = probe_camera("gated", "https://example.invalid/x.m3u8", thresholds=SHORT)

        # Connectable: the gateway answered. Dispatching a technician for an expired cookie wastes
        # somebody's day.
        assert result.connectable is True
        assert result.retryable is False
        assert "cookie" in result.breakdown["note"]


def test_stream_options_never_sends_an_empty_cookie_header() -> None:
    from workers.prober.probe import stream_options

    assert "headers" not in stream_options(None, "UA")
    assert "Cookie: abc" in stream_options("abc", "UA")["headers"]
