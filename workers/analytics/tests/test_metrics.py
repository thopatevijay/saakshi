"""Tests for the analytics worker's Prometheus exposition (D3-10).

The collector reads live pipeline state at scrape time, so it can be driven with a stub that has the
same three attributes a real `CameraPipeline` exposes. That is the point of the design: nothing is
buffered, so a test that sets the counters and collects is testing exactly what Prometheus sees.
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry

from workers.analytics.capabilities import CameraCapabilities
from workers.analytics.metrics import COMPONENT, PipelineCollector
from workers.analytics.pipeline import CameraSource, CameraStats


class FakePipeline:
    """The three attributes the collector reads off a real `CameraPipeline`."""

    def __init__(
        self,
        stats: CameraStats,
        *,
        connected: bool = True,
        last_frame_at: float = 0.0,
        capabilities: CameraCapabilities | None = None,
        declared_fps: float | None = None,
    ) -> None:
        self.stats = stats
        self.connected = connected
        self.last_frame_at = last_frame_at
        self.capabilities = capabilities
        self.source = CameraSource(
            external_id=stats.external_id, url=stats.url, declared_fps=declared_fps
        )


def collect(*pipelines: FakePipeline, inference: object | None = None) -> CollectorRegistry:
    registry = CollectorRegistry()
    registry.register(PipelineCollector(pipelines, inference=inference))  # type: ignore[arg-type]
    return registry


def sample(registry: CollectorRegistry, name: str, **labels: str) -> float | None:
    return registry.get_sample_value(name, {"component": COMPONENT, **labels})


def stats(external_id: str = "cam01", **overrides: object) -> CameraStats:
    return CameraStats(external_id=external_id, url="rtsp://example/x", **overrides)  # type: ignore[arg-type]


class TestThreeRates:
    """Declared, measured and effective are three different questions.

    On the government sandbox `cam01` declares 30, carries 14.99 and delivers 4.00 — the gateway
    throttles roughly tenfold. A board with one fps number cannot show that, and every capacity
    claim about the department feed depends on it.
    """

    def test_all_three_rates_are_exported_separately(self) -> None:
        # 14.99 fps of content, and 800 frames over 200 s of wall time = 4.0 effective.
        registry = collect(
            FakePipeline(
                stats(
                    measured_fps=14.99,
                    frames_decoded=800,
                    upstream_wait_s=184.0,
                    loop_self_time_s=16.0,
                ),
                capabilities=CameraCapabilities(width=1920, height=1080, codec="h264",
                                                declared_fps=30.0),
            )
        )

        assert sample(registry, "saakshi_worker_camera_declared_fps", camera="cam01") == 30.0
        assert sample(registry, "saakshi_worker_camera_measured_fps", camera="cam01") == 14.99
        assert sample(registry, "saakshi_worker_camera_effective_fps", camera="cam01") == 4.0

    def test_the_registry_declaration_is_the_fallback_when_the_container_declares_nothing(
        self,
    ) -> None:
        registry = collect(FakePipeline(stats(), declared_fps=25.0))

        assert sample(registry, "saakshi_worker_camera_declared_fps", camera="cam01") == 25.0

    def test_a_camera_that_declares_nothing_anywhere_publishes_no_declared_series(self) -> None:
        """All 30 sandbox rows carry `declared_fps = NULL`; an invented 0 would be a false claim."""
        registry = collect(FakePipeline(stats()))

        assert sample(registry, "saakshi_worker_camera_declared_fps", camera="cam01") is None


class TestNullIsNotZero:
    def test_an_unmeasured_rate_publishes_a_marker_and_no_number(self) -> None:
        registry = collect(FakePipeline(stats(measured_fps=None)))

        assert sample(registry, "saakshi_worker_camera_measured_fps", camera="cam01") is None
        assert (
            sample(
                registry,
                "saakshi_worker_camera_fps_unmeasurable",
                camera="cam01",
                reason="no_pts_window_yet",
            )
            == 1.0
        )

    def test_a_camera_with_no_frames_yet_publishes_no_effective_rate(self) -> None:
        registry = collect(FakePipeline(stats(frames_decoded=0, upstream_wait_s=30.0)))

        assert sample(registry, "saakshi_worker_camera_effective_fps", camera="cam01") is None

    def test_seconds_since_frame_is_absent_before_the_first_frame(self) -> None:
        registry = collect(FakePipeline(stats(), last_frame_at=0.0))

        assert sample(registry, "saakshi_worker_camera_seconds_since_frame", camera="cam01") is None


class TestStarvationIsARatio:
    """A slow gateway looks exactly like a broken worker, and one latency cannot tell them apart.

    D1-09 measured 2302.9 s blocked upstream against 150.1 s of our own loop over a 22-minute soak,
    with zero reconnects. The two counters are exported separately so that ratio is drawable.

    Note the arithmetic: 2302.9 / (2302.9 + 150.1) is **93.9%**, while D1-09's handoff reports the
    headline as "92% upstream-bound" — the two are computed over different denominators. The
    exporter publishes the raw seconds and lets the dashboard divide, so a reader can always
    reproduce the figure rather than inherit somebody's rounding. Logged to BL-01.
    """

    def test_upstream_and_self_time_are_separate_counters(self) -> None:
        registry = collect(FakePipeline(stats(upstream_wait_s=2302.9, loop_self_time_s=150.1)))

        upstream = sample(
            registry, "saakshi_worker_camera_upstream_wait_seconds_total", camera="cam01"
        )
        own = sample(registry, "saakshi_worker_camera_loop_self_seconds_total", camera="cam01")

        assert upstream == 2302.9
        assert own == 150.1
        assert upstream is not None and own is not None
        # Overwhelmingly upstream-bound, which is the finding. There is nothing to fix in this
        # pipeline at this ratio, and a board that showed only "fps fell" would have said otherwise.
        assert round(upstream / (upstream + own), 3) == 0.939


class TestCameraDownSignal:
    """The camera-down alert reads this, not a frame rate: a 54.6 s stall with zero reconnects was
    measured on a HEALTHY camera, and calling that an outage would blame us for the gateway."""

    def test_connected_is_one_while_a_session_is_open_and_zero_when_it_is_not(self) -> None:
        registry = collect(
            FakePipeline(stats("up"), connected=True),
            FakePipeline(stats("down"), connected=False),
        )

        assert sample(registry, "saakshi_worker_camera_connected", camera="up") == 1.0
        assert sample(registry, "saakshi_worker_camera_connected", camera="down") == 0.0
        assert registry.get_sample_value(
            "saakshi_worker_cameras_connected", {"component": COMPONENT}
        ) == 1.0

    def test_a_camera_that_never_connected_is_still_a_series(self) -> None:
        """"Absent" and "down" must not look alike: a missing series is a monitoring gap."""
        registry = collect(FakePipeline(stats("never"), connected=False))

        assert sample(registry, "saakshi_worker_camera_connected", camera="never") == 0.0


class TestPipelineCounters:
    def test_the_motion_gate_skip_ratio_and_the_counters_behind_it_are_both_exported(self) -> None:
        registry = collect(
            FakePipeline(stats(frames_considered=1000, inferences_run=675, frames_decoded=1000))
        )

        assert (
            sample(registry, "saakshi_worker_camera_motion_gate_skip_ratio", camera="cam01")
            == 0.325
        )
        assert (
            sample(registry, "saakshi_worker_camera_frames_considered_total", camera="cam01")
            == 1000.0
        )
        assert sample(registry, "saakshi_worker_camera_inferences_total", camera="cam01") == 675.0

    def test_decoder_warnings_are_split_benign_from_other(self) -> None:
        registry = collect(FakePipeline(stats(benign_warnings=912, other_warnings=520)))

        assert (
            sample(
                registry, "saakshi_worker_camera_decoder_warnings_total", camera="cam01",
                kind="benign",
            )
            == 912.0
        )
        assert (
            sample(
                registry, "saakshi_worker_camera_decoder_warnings_total", camera="cam01",
                kind="other",
            )
            == 520.0
        )

    def test_retryable_errors_are_labelled_apart_from_real_faults(self) -> None:
        registry = collect(
            FakePipeline(stats(errors=["ExitError: x", "ValueError: y"], retryable_errors=1))
        )

        assert (
            sample(
                registry, "saakshi_worker_camera_decode_errors_total", camera="cam01",
                retryable="true",
            )
            == 1.0
        )
        assert (
            sample(
                registry, "saakshi_worker_camera_decode_errors_total", camera="cam01",
                retryable="false",
            )
            == 1.0
        )

    def test_measured_shape_travels_as_labels_never_as_a_declared_assumption(self) -> None:
        registry = collect(
            FakePipeline(stats(resolution="854x480", codec="h264", imgsz=864))
        )

        assert (
            sample(
                registry, "saakshi_worker_camera_info", camera="cam01", resolution="854x480",
                codec="h264", imgsz="864",
            )
            == 1.0
        )


class TestInferenceStats:
    def test_detector_latency_percentiles_are_exported_when_the_detector_kept_them(self) -> None:
        class Stub:
            calls = 23_023

            @staticmethod
            def percentile(p: float) -> float | None:
                return {50: 18.91, 95: 47.02}.get(int(p))

        registry = collect(FakePipeline(stats()), inference=Stub())

        assert registry.get_sample_value(
            "saakshi_worker_inference_calls_total", {"component": COMPONENT}
        ) == 23_023
        assert sample(registry, "saakshi_worker_inference_latency_ms", quantile="p50") == 18.91
        assert sample(registry, "saakshi_worker_inference_latency_ms", quantile="p95") == 47.02
