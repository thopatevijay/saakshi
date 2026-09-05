"""Tests for the prober's Prometheus exposition (D3-10).

Every case here guards a semantic that has already been got wrong once in this project. They are
deliberately not "does the gauge exist" tests: a metric that exists and lies is worse than one that
is missing, because a board built on it looks authoritative.
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry

from workers.prober.metrics import COMPONENT, ProberMetrics
from workers.prober.probe import ProbeResult


def sample(registry: CollectorRegistry, name: str, **labels: str) -> float | None:
    """The value of one sample, or `None` when the series is absent."""
    return registry.get_sample_value(name, {"component": COMPONENT, **labels})


class TestNullIsNotZero:
    """`measured_fps IS NULL` means *could not measure*, never zero (D1-05).

    The same camera measured unmeasurable after a 516,783 ms probe and 20 fps after an 85,536 ms
    one — same code, same camera, different network. Publishing the first as 0 blames the camera
    for the gateway.
    """

    def test_an_unmeasurable_rate_publishes_no_fps_sample_at_all(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(
            ProbeResult(
                "cam12",
                connectable=True,
                decodable=True,
                measured_fps=None,
                breakdown={"fps": {"unmeasurable_reason": "too_slow_to_measure"}},
            )
        )

        assert sample(registry, "saakshi_prober_camera_measured_fps", camera="cam12") is None
        assert (
            sample(
                registry,
                "saakshi_prober_camera_fps_unmeasurable",
                camera="cam12",
                reason="too_slow_to_measure",
            )
            == 1.0
        )

    def test_a_measured_rate_publishes_the_number_and_no_marker(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(
            ProbeResult(
                "cam01",
                connectable=True,
                decodable=True,
                measured_fps=15.4,
                breakdown={"fps": {"declared": 30, "diverged": True}},
            )
        )

        assert sample(registry, "saakshi_prober_camera_measured_fps", camera="cam01") == 15.4
        assert sample(registry, "saakshi_prober_camera_declared_fps", camera="cam01") == 30.0
        assert sample(registry, "saakshi_prober_camera_fps_diverged", camera="cam01") == 1.0

    def test_a_rate_that_becomes_unmeasurable_stops_publishing_the_old_number(self) -> None:
        """A stale sample is worse than an absent one: a stale one looks healthy."""
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(ProbeResult("cam12", connectable=True, decodable=True, measured_fps=20.0))
        assert sample(registry, "saakshi_prober_camera_measured_fps", camera="cam12") == 20.0

        metrics.record(
            ProbeResult(
                "cam12",
                connectable=True,
                decodable=True,
                measured_fps=None,
                breakdown={"fps": {"unmeasurable_reason": "gateway_too_slow"}},
            )
        )
        assert sample(registry, "saakshi_prober_camera_measured_fps", camera="cam12") is None


class TestDriftCarriesItsMeaning:
    """`pts_drift_ms` means encoder clock drift on live and pull-rate skew on VOD.

    Every sandbox row is VOD, where the median is 124,007 ms. An alert on raw drift would fire on
    all 30 cameras, all the time, and truthfully mean nothing.
    """

    def test_vod_and_live_drift_land_on_different_series(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(
            ProbeResult(
                "cam01",
                connectable=True,
                decodable=True,
                pts_drift_ms=124_007,
                breakdown={"pts_drift_meaning": "vod"},
            )
        )
        metrics.record(
            ProbeResult(
                "cam99",
                connectable=True,
                decodable=True,
                pts_drift_ms=42,
                breakdown={"pts_drift_meaning": "live"},
            )
        )

        assert (
            sample(registry, "saakshi_prober_camera_pts_drift_ms", camera="cam01", meaning="vod")
            == 124_007
        )
        assert (
            sample(registry, "saakshi_prober_camera_pts_drift_ms", camera="cam01", meaning="live")
            is None
        )
        assert (
            sample(registry, "saakshi_prober_camera_pts_drift_ms", camera="cam99", meaning="live")
            == 42
        )

    def test_drift_with_no_recorded_meaning_is_labelled_unknown_not_guessed(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(ProbeResult("cam07", connectable=True, decodable=True, pts_drift_ms=99))

        assert (
            sample(
                registry, "saakshi_prober_camera_pts_drift_ms", camera="cam07", meaning="unknown"
            )
            == 99
        )


class TestFailureIsNotAVerdict:
    """A timeout says something about the network and nothing about the camera (D1-03, D1-05)."""

    def test_a_retryable_failure_is_labelled_as_one(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(
            ProbeResult(
                "cam06",
                connectable=False,
                decodable=False,
                error="ExitError: timed out",
                retryable=True,
            )
        )

        assert (
            sample(
                registry, "saakshi_prober_camera_probe_failed", camera="cam06", retryable="true"
            )
            == 1.0
        )
        assert (
            sample(
                registry, "saakshi_prober_camera_probe_failed", camera="cam06", retryable="false"
            )
            is None
        )
        assert sample(registry, "saakshi_prober_results_total", outcome="retryable") == 1.0

    def test_outcomes_are_counted_apart(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        metrics.record(ProbeResult("a", connectable=True, decodable=True))
        metrics.record(ProbeResult("b", connectable=False, decodable=False, retryable=False))
        metrics.record(ProbeResult("c", connectable=True, decodable=False, retryable=False))

        assert sample(registry, "saakshi_prober_results_total", outcome="decodable") == 1.0
        assert sample(registry, "saakshi_prober_results_total", outcome="unreachable") == 1.0
        assert sample(registry, "saakshi_prober_results_total", outcome="undecodable") == 1.0


class TestPassLevelNumbers:
    def test_a_completed_sweep_records_its_size_and_wall_time(self) -> None:
        registry = CollectorRegistry()
        metrics = ProberMetrics(registry)

        # The measured baseline: 30 cameras in 1418.5 s at pool 4.
        metrics.record_pass(cameras=30, duration_s=1418.5)

        assert registry.get_sample_value(
            "saakshi_prober_pass_cameras", {"component": COMPONENT}
        ) == 30.0
        assert registry.get_sample_value(
            "saakshi_prober_pass_duration_seconds", {"component": COMPONENT}
        ) == 1418.5
